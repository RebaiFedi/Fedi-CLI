/**
 * Extracted binding logic for the Orchestrator.
 *
 * This module registers all output/status handlers on agents and bus,
 * manages relay detection, cross-talk muting, buffering, and auto-restart.
 * It keeps orchestrator.ts focused on lifecycle, config, and user messaging.
 */

import PQueue from 'p-queue';
import type { AgentProcess, AgentId, Message, OutputLine, AgentStatus } from '../agents/types.js';
import type { OrchestratorCallbacks } from './orchestrator.js';
import type { MessageBus } from './message-bus.js';
import type { DelegateTracker } from './delegate-tracker.js';
import type { RelayRouter } from './relay-router.js';
import type { CrossTalkManager } from './cross-talk-manager.js';
import type { BufferManager } from './buffer-manager.js';
import { getOpusSystemPrompt } from './prompts.js';
import { flog } from '../utils/log.js';
import { loadUserConfig } from '../config/user-config.js';

type WorkerAgentId = 'sonnet' | 'codex';

/**
 * Internal surface of the Orchestrator that the bind module needs.
 * This avoids making orchestrator properties public while allowing extraction.
 */
export interface OrchestratorBindContext {
  readonly agents: Record<AgentId, AgentProcess>;
  readonly opus: AgentProcess;
  readonly bus: MessageBus;
  readonly delegates: DelegateTracker;
  readonly relay: RelayRouter;
  readonly crossTalk: CrossTalkManager;
  readonly buffers: BufferManager;
  readonly opusQueue: PQueue;
  readonly sonnetQueue: PQueue;
  readonly codexQueue: PQueue;
  readonly agentLastContextIndex: Map<AgentId, number>;
  readonly crossTalkDeferredTimers: Set<ReturnType<typeof setTimeout>>;

  // Mutable state
  stopping: boolean;
  started: boolean;
  opusPreTagEmitted: boolean;
  config: { projectDir: string; claudePath: string; codexPath: string } | null;
  opusAllMode: boolean;
  opusAllModeResponded: boolean;
  opusAllModeWorkerTimer: ReturnType<typeof setTimeout> | null;
  opusAllModePendingText: string | null;
  opusRestartPending: boolean;
  opusRestartTimer: ReturnType<typeof setTimeout> | null;
  opusRestartCount: number;
  readonly MAX_OPUS_RESTARTS: number;
  busListeners: Array<{ event: string; handler: (...args: unknown[]) => void }>;

  // Methods
  isAgentEnabled(agentId: AgentId): boolean;
  ensureWorkerStarted(agentId: WorkerAgentId): Promise<void>;
  getWorkerReady(agentId: WorkerAgentId): Promise<void>;
  sendToWorkersDirectly(text: string): void;
  noteOpusRateLimitFromText(text: string): void;
  isOpusRateLimited(): boolean;
}

// ── Context helpers ──

function getNewContext(ctx: OrchestratorBindContext, agent: AgentId): string {
  const sinceIndex = ctx.agentLastContextIndex.get(agent) ?? 0;
  const { summary, newIndex } = ctx.bus.getContextSummary(agent, sinceIndex);
  ctx.agentLastContextIndex.set(agent, newIndex);
  return summary;
}

export function getOpusContextReminder(ctx: OrchestratorBindContext): string {
  const lines: string[] = [];
  lines.push('[RAPPEL SYSTEME]');
  lines.push(
    '- Tu es Opus, DIRECTEUR. Tu DELEGUES: frontend→Sonnet, backend→Codex. Tu ne travailles JAMAIS seul sauf si le user dit "toi-meme" ou [FALLBACK].',
  );
  lines.push(
    '- Apres [TO:SONNET]/[TO:CODEX]: UNE phrase puis STOP. ZERO outil (Read, Glob, Grep, Bash, Write, Edit).',
  );
  lines.push(
    "- Quand tu recois les rapports de tes agents: ecris UN rapport final complet et structure pour le user. Decris le travail en detail MAIS sans blocs de code source. Le user n'a RIEN vu avant. REPONDS RAPIDEMENT.",
  );

  if (ctx.delegates.expectedDelegateCount > 0) {
    const agentNames = ctx.delegates
      .getExpectedDelegates()
      .map((a) => a.charAt(0).toUpperCase() + a.slice(1))
      .join(' et ');
    const received = ctx.delegates.pendingReportCount;
    const total = ctx.delegates.expectedDelegateCount;
    lines.push(
      `- MAINTENANT: ${agentNames} travaille(nt) (${received}/${total} rapports recus). ATTENDS en silence. AUCUN outil.`,
    );

    const activeOnRelay = ctx.relay.getAgentsOnRelay().filter((a) => {
      const s = ctx.agents[a].status;
      return s === 'running' || s === 'compacting';
    });
    if (activeOnRelay.length > 0) {
      const activeNames = activeOnRelay.map((a) => a.charAt(0).toUpperCase() + a.slice(1));
      if (activeNames.length === 1) {
        lines.push(
          `- Le user envoie un message PENDANT que ${activeNames[0]} travaille. Tu DOIS TRANSMETTRE ce message a ${activeNames[0]} via le tag de delegation habituel. Le systeme va l'injecter en LIVE a l'agent. Ecris le tag suivi du message du user (reformule si besoin). Puis UNE phrase au user ("Bien note, c'est transmis a ${activeNames[0]}.") et STOP.`,
        );
      } else {
        const allNames = activeNames.join(' et ');
        lines.push(
          `- Le user envoie un message PENDANT que ${allNames} travaillent. DECIDE quel agent est concerne par le message du user. Transmets-le UNIQUEMENT a l'agent concerne via le tag de delegation. Si ca concerne les deux, transmets aux deux. Puis UNE phrase au user et STOP.`,
        );
      }
    }
  }
  return lines.join('\n');
}

function getWorkerContextReminder(
  ctx: OrchestratorBindContext,
  agentId: string,
  fromAgent: string,
): string {
  const from = fromAgent.toUpperCase();
  const peer = agentId === 'sonnet' ? 'Codex' : 'Sonnet';
  const role = agentId === 'sonnet' ? 'ingenieur frontend' : 'ingenieur backend';
  const name = agentId === 'sonnet' ? 'Sonnet' : 'Codex';
  const hasReported = ctx.delegates.hasPendingReport(agentId as AgentId);

  if (hasReported) {
    return `[RAPPEL] Tu es ${name}, ${role}. Tu as DEJA envoye ton rapport [TO:OPUS]. Ta tache est terminee. Ne renvoie plus de messages — le systeme les ignorera.`;
  }
  if (from === 'OPUS') {
    return `[RAPPEL] Tu es ${name}, ${role}. Dis BRIEVEMENT ce que tu vas faire (1-2 phrases), puis FAIS LE TRAVAIL (Write, Edit, Bash...), puis QUAND TU AS FINI envoie [TO:OPUS] avec le resume. [TO:OPUS] = DERNIERE action, JAMAIS la premiere. Ne parle PAS au user.`;
  }
  if (from === 'USER') {
    return `[RAPPEL] Tu es ${name}, ${role}. Le user te parle directement. Reponds au user. PAS de [TO:OPUS].`;
  }
  if (from === peer.toUpperCase()) {
    return `[RAPPEL] Tu es ${name}, ${role}. ${peer} te parle — reponds avec des INFOS TECHNIQUES utiles. Quand la coordination est finie, envoie [TO:OPUS] avec ton rapport. Apres [TO:OPUS], ne renvoie plus de messages.`;
  }
  return '';
}

// ── Worker binding ──

function bindWorkerRoute(
  ctx: OrchestratorBindContext,
  agentId: WorkerAgentId,
  queue: PQueue,
): void {
  const handler = (msg: Message) => {
    if (!ctx.isAgentEnabled(agentId)) return;
    flog.debug('BUS', `${msg.from}->${msg.to}`, { preview: msg.content.slice(0, 100) });
    if (msg.from === agentId) return;
    if (msg.from !== 'opus' && msg.from !== 'user' && ctx.crossTalk.isAwaitingReply(agentId)) {
      flog.info(
        'ORCH',
        `${agentId} received cross-talk reply from ${msg.from} — no longer awaiting`,
      );
      ctx.crossTalk.clearAwaitingReply(agentId);
      // Release the turn so the other agent (or a queued message) can proceed
      ctx.crossTalk.releaseTurn();
      // Deliver any queued cross-talk message that was waiting for the turn
      const pending = ctx.crossTalk.dequeuePending();
      if (pending) {
        flog.info('ORCH', `Delivering queued cross-talk: ${pending.from}->${pending.target}`);
        setTimeout(() => {
          ctx.relay.routeRelayMessage(pending.from, pending.target, pending.content);
        }, 0);
      }
    }
    queue.add(async () => {
      if (!ctx.started) return;
      await ctx.ensureWorkerStarted(agentId);
      await ctx.getWorkerReady(agentId);
      if (!ctx.started) return;
      if (ctx.crossTalk.isOnCrossTalk(agentId)) {
        ctx.crossTalk.setOnCrossTalk(agentId, Date.now());
      }
      const prefix = `[FROM:${msg.from.toUpperCase()}]`;
      const context = getNewContext(ctx, agentId);
      let payload = `${prefix} ${msg.content}`;
      if (context) payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
      const workerReminder = getWorkerContextReminder(ctx, agentId, msg.from);
      if (workerReminder) payload = `${workerReminder}\n\n${payload}`;
      ctx.agents[agentId].send(payload);
    });
  };
  const event = `message:${agentId}`;
  ctx.bus.on(event, handler);
  ctx.busListeners.push({ event, handler: handler as (...args: unknown[]) => void });
}

function bindWorkerAgent(
  ctx: OrchestratorBindContext,
  agentId: AgentId,
  agent: AgentProcess,
  cb: OrchestratorCallbacks,
): void {
  const label = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  const cfg = loadUserConfig();
  const crossTalkMuteTimeout = cfg.crossTalkMuteTimeoutMs;
  const crossTalkClearThreshold = cfg.crossTalkClearThresholdMs;

  agent.onOutput((line: OutputLine) => {
    if ((line.type as string) === 'checkpoint') return;
    if (ctx.stopping) return;

    flog.debug('AGENT', 'Output', {
      agent: agentId,
      type: line.type,
      text: line.text.slice(0, 150),
    });
    ctx.delegates.recordActivity(agentId);

    if (line.type === 'stdout' && line.text.includes('API Error:')) {
      flog.warn('ORCH', `${label} API error detected`);
      cb.onAgentOutput(agentId, {
        text: `${label}: limite de tokens atteinte — reprise en cours...`,
        timestamp: Date.now(),
        type: 'info',
      });
    }

    if (ctx.delegates.isDeliveredToOpus(agentId)) {
      flog.debug('ORCH', `${label} output MUTED (delivered to Opus, type=${line.type})`);
      return;
    }

    if (ctx.opusAllMode && ctx.delegates.expectedDelegateCount > 0 && line.type === 'stdout') {
      flog.debug('ORCH', `${label} stdout BLOCKED (@tous delegation active)`);
      ctx.relay.detectRelayPatterns(agentId, line.text);
      ctx.buffers.pushToBuffer(agentId, line);
      ctx.buffers.maybeEmitStatusSnippet(agentId, line.text, cb);
      return;
    }

    if (ctx.delegates.hasPendingReport(agentId) && line.type === 'stdout') {
      flog.debug('ORCH', `${label} output MUTED (already reported to Opus)`);
      ctx.relay.detectRelayPatterns(agentId, line.text);
      return;
    }

    // Cross-talk mute handling
    if (ctx.crossTalk.isOnCrossTalk(agentId)) {
      const muteTime = ctx.crossTalk.getCrossTalkTime(agentId)!;
      if (Date.now() - muteTime > crossTalkMuteTimeout) {
        flog.warn(
          'ORCH',
          `${label} cross-talk mute timeout (${crossTalkMuteTimeout / 1000}s) — unmuting`,
        );
        ctx.crossTalk.clearOnCrossTalk(agentId);
      } else {
        ctx.relay.detectRelayPatterns(agentId, line.text);
        if (ctx.relay.isOnRelay(agentId) && line.type !== 'stdout' && line.type !== 'stderr') {
          ctx.relay.setRelayStart(agentId, Date.now());
        }
        if (ctx.relay.isOnRelay(agentId) && line.type === 'stdout') {
          flog.debug('BUFFER', 'On cross-talk + relay for opus', { agent: agentId });
          if (/\[TASK:(add|done)\]/i.test(line.text)) cb.onAgentOutput(agentId, line);
          ctx.buffers.pushToBuffer(agentId, line);
          ctx.buffers.maybeEmitStatusSnippet(agentId, line.text, cb);
        }
        if (line.type !== 'stdout') cb.onAgentOutput(agentId, line);
        return;
      }
    }

    // On relay — buffer stdout, pass actions
    if (ctx.relay.isOnRelay(agentId)) {
      if (line.type !== 'stdout' && line.type !== 'stderr') {
        ctx.relay.setRelayStart(agentId, Date.now());
      }
      const start = ctx.relay.getRelayStart(agentId) ?? 0;
      const elapsed = Date.now() - start;
      const relayTimeout = ctx.relay.getRelayTimeout(agentId);
      const isActive = agent.status === 'running' || agent.status === 'compacting';

      if (relayTimeout > 0 && elapsed > relayTimeout && !isActive) {
        flog.warn(
          'ORCH',
          `${label} relay timeout (${Math.round(elapsed / 1000)}s) — forcing auto-relay`,
        );
        ctx.delegates.autoRelayBuffer(agentId, ctx.relay);
      } else {
        if (relayTimeout > 0 && elapsed > relayTimeout && isActive) {
          flog.debug(
            'ORCH',
            `${label} relay past timeout but agent still running — NOT timing out`,
          );
        }
        ctx.relay.detectRelayPatterns(agentId, line.text);
        if (line.type === 'stdout') {
          flog.debug('BUFFER', 'On relay for opus', { agent: agentId });
          if (/\[TASK:(add|done)\]/i.test(line.text)) cb.onAgentOutput(agentId, line);
          ctx.buffers.pushToBuffer(agentId, line);
          ctx.buffers.maybeEmitStatusSnippet(agentId, line.text, cb);
        } else {
          cb.onAgentOutput(agentId, line);
        }
        return;
      }
    }

    const { foundRelayTag, preTagLines } = ctx.relay.detectRelayPatterns(agentId, line.text);
    if (foundRelayTag && preTagLines.length > 0 && line.type === 'stdout') {
      // Worker pre-tag text (before [TO:OPUS]) is part of the report — buffer it for relay
      ctx.buffers.pushToBuffer(agentId, {
        text: preTagLines.join('\n'),
        timestamp: line.timestamp,
        type: 'stdout',
      });
      return;
    }
    if (!foundRelayTag) cb.onAgentOutput(agentId, line);
  });

  agent.onStatusChange((s: AgentStatus) => {
    flog.info('AGENT', `${agentId}: ${s}`, { agent: agentId });
    if (ctx.stopping) {
      cb.onAgentStatus(agentId, s);
      return;
    }
    ctx.delegates.recordActivity(agentId);

    if (s === 'running') {
      ctx.delegates.clearSafetyNetTimer(agentId);
    }
    if (s === 'waiting' || s === 'stopped' || s === 'error') {
      ctx.relay.flushRelayDraft(agentId);
    }

    // Cross-talk mute clearing
    if (s === 'waiting' || s === 'stopped' || s === 'error') {
      // Release turn if this agent was the speaker and is no longer awaiting a reply
      if (
        ctx.crossTalk.getCurrentSpeaker() === agentId &&
        !ctx.crossTalk.isAwaitingReply(agentId)
      ) {
        ctx.crossTalk.releaseTurn();
        const pending = ctx.crossTalk.dequeuePending();
        if (pending) {
          flog.info('ORCH', `Delivering queued cross-talk (status change): ${pending.from}->${pending.target}`);
          setTimeout(() => {
            ctx.relay.routeRelayMessage(pending.from, pending.target, pending.content);
          }, 0);
        }
      }

      const muteTime = ctx.crossTalk.getCrossTalkTime(agentId);
      if (muteTime !== undefined) {
        const elapsed = Date.now() - muteTime;
        if (elapsed > crossTalkClearThreshold || s === 'stopped' || s === 'error') {
          flog.info(
            'ORCH',
            `Cross-talk MUTE CLEARED for ${agentId} (status=${s}, elapsed=${elapsed}ms)`,
          );
          ctx.crossTalk.clearOnCrossTalk(agentId);
          if (ctx.delegates.allReportsReceived()) {
            ctx.delegates.deliverCombinedReports();
          }
        } else {
          flog.info(
            'ORCH',
            `Cross-talk mute kept for ${agentId} (status=${s}, elapsed=${elapsed}ms — too soon)`,
          );
          const remaining = crossTalkClearThreshold - elapsed + 50;
          const deferredTimer = setTimeout(() => {
            ctx.crossTalkDeferredTimers.delete(deferredTimer);
            if (!ctx.crossTalk.isOnCrossTalk(agentId)) return;
            flog.info('ORCH', `Cross-talk MUTE CLEARED for ${agentId} (deferred timer fired)`);
            ctx.crossTalk.clearOnCrossTalk(agentId);
            if (ctx.delegates.allReportsReceived()) {
              ctx.delegates.deliverCombinedReports();
            }
          }, remaining);
          ctx.crossTalkDeferredTimers.add(deferredTimer);
        }
      }
    }

    // Agent stopped/error — handle fallback
    if (s === 'stopped' || s === 'error') {
      flog.info('RELAY', `${agentId}: end`, { agent: agentId, detail: `status=${s}` });
      ctx.relay.removeFromRelay(agentId);
      ctx.buffers.clearBuffer(agentId);
      ctx.relay.removeRelayStart(agentId);

      if (
        ctx.delegates.isExpectedDelegate(agentId) &&
        !ctx.delegates.hasPendingReport(agentId)
      ) {
        const originalTask = ctx.delegates.getLastDelegation(agentId);
        ctx.delegates.markAgentFailed(agentId);
        const fallback = ctx.delegates.pickFallbackAgent(agentId);

        if (fallback && fallback !== 'opus' && originalTask) {
          flog.info('ORCH', `Agent ${agentId} ${s} — fallback to ${fallback}`);
          ctx.delegates.addExpectedDelegate(fallback);
          ctx.delegates.removeDeliveredToOpus(fallback);
          ctx.relay.addOnRelay(fallback);
          ctx.relay.setRelayStart(fallback, Date.now());
          ctx.delegates.setLastDelegation(fallback, originalTask);
          ctx.delegates.recordActivity(fallback);
          ctx.relay.recordRelay();
          ctx.bus.relay('opus', fallback, `[FALLBACK — ${agentId} ${s}] ${originalTask}`);
          cb.onAgentOutput(agentId, {
            text: `${agentId} ${s} — tache transferee a ${fallback}`,
            timestamp: Date.now(),
            type: 'info',
          });
        } else if (fallback === 'opus' && originalTask) {
          flog.info('ORCH', `Agent ${agentId} ${s}, no worker fallback — Opus takes over`);
          ctx.delegates.clearExpectedDelegates();
          ctx.delegates.clearPendingReports();
          ctx.delegates.stopHeartbeat();
          ctx.bus.send({
            from: 'system',
            to: 'opus',
            content: `[FALLBACK — ${agentId} ${s}, aucun agent disponible] Fais le travail toi-meme: ${originalTask}`,
          });
          cb.onAgentOutput(agentId, {
            text: `${agentId} ${s} — Opus prend le relais`,
            timestamp: Date.now(),
            type: 'info',
          });
        } else {
          ctx.delegates.setPendingReport(agentId, `(agent ${s} — pas de rapport)`);
          if (ctx.delegates.allReportsReceived()) {
            ctx.delegates.deliverCombinedReports();
          }
        }
      }

      if (!ctx.relay.isOpusWaitingForRelays() && ctx.delegates.expectedDelegateCount === 0) {
        ctx.buffers.flushOpusBuffer(cb);
      }
    }

    // Safety-net auto-relay
    if (
      s === 'waiting' &&
      ctx.relay.isOnRelay(agentId) &&
      !ctx.crossTalk.isAwaitingReply(agentId)
    ) {
      const timer = setTimeout(() => {
        if (!ctx.relay.isOnRelay(agentId) || ctx.delegates.hasPendingReport(agentId)) return;
        const agentInstance = ctx.agents[agentId];
        if (agentInstance.status === 'running' || agentInstance.status === 'compacting') {
          flog.info(
            'ORCH',
            `Safety-net deferred for ${agentId} — agent still ${agentInstance.status}`,
          );
          return;
        }
        ctx.delegates.autoRelayBuffer(agentId, ctx.relay);
      }, loadUserConfig().safetyNetDebounceMs);
      ctx.delegates.setSafetyNetTimer(agentId, timer);
    }

    cb.onAgentStatus(agentId, s);
  });
}

// ── Main bind function ──

/**
 * Registers all orchestrator callbacks: opus output/status, worker agents,
 * bus relay routing, and message delivery to agents.
 */
export function bindOrchestrator(ctx: OrchestratorBindContext, cb: OrchestratorCallbacks): void {
  // Clear all previous handlers to prevent duplicates on re-bind
  for (const agent of Object.values(ctx.agents)) {
    agent.clearHandlers();
  }

  // Remove previous bus listeners
  for (const { event, handler } of ctx.busListeners) {
    ctx.bus.off(event, handler);
  }
  ctx.busListeners = [];

  // Helper to register bus listeners with tracking for cleanup
  const onBus = (event: string, handler: (...args: unknown[]) => void) => {
    ctx.bus.on(event, handler);
    ctx.busListeners.push({ event, handler });
  };

  // ── Opus output handler ──
  ctx.opus.onOutput((line: OutputLine) => {
    if (line.type === 'checkpoint') return;
    if (ctx.stopping) return;
    if (line.type === 'info') ctx.noteOpusRateLimitFromText(line.text);
    // Mute Opus stdout while user is talking directly to a worker
    if (
      line.type === 'stdout' &&
      (ctx.relay.isDirectMode('sonnet') || ctx.relay.isDirectMode('codex'))
    ) {
      flog.debug('ORCH', 'Opus stdout muted (user in direct worker mode)');
      return;
    }
    flog.debug('AGENT', 'Output', {
      agent: 'opus',
      type: line.type,
      text: line.text.slice(0, 150),
    });
    const delegatesBefore = ctx.delegates.expectedDelegateCount;
    const { foundRelayTag, preTagLines } = ctx.relay.detectRelayPatterns('opus', line.text);

    if (preTagLines.length > 0 && delegatesBefore === 0 && line.type === 'stdout') {
      const preTagText = preTagLines.join('\n');
      flog.debug('ORCH', `Opus pre-tag text emitted: ${preTagText.slice(0, 100)}`);
      cb.onAgentOutput('opus', {
        text: preTagText,
        timestamp: line.timestamp,
        type: 'stdout',
      });
      // Mark that pre-tag text was just emitted — prevents re-buffering
      ctx.opusPreTagEmitted = true;
      // Pre-tag text already emitted — always return to prevent duplication.
      // If a relay tag was found, detectRelayPatterns already created the draft.
      // If no relay tag, the line was just conversational text (already emitted above).
      return;
    }

    if (ctx.delegates.expectedDelegateCount > 0) {
      if (line.type === 'stdout') {
        // Skip buffering if this line immediately follows pre-tag emission
        // (the text was already shown to the user)
        if (ctx.opusPreTagEmitted) {
          ctx.opusPreTagEmitted = false;
          return;
        }
        const stripped = line.text.replace(/\[TASK:(add|done)\][^\n]*/gi, '').trim();
        if (stripped.length > 0) {
          flog.debug(
            'BUFFER',
            `Opus stdout BUFFERED (${ctx.delegates.expectedDelegateCount} delegates pending)`,
            { agent: 'opus' },
          );
          ctx.buffers.pushToBuffer('opus', line);
          ctx.buffers.maybeEmitStatusSnippet('opus', line.text, cb);
          return;
        }
      }
      if (!ctx.opusAllMode && line.type === 'system') {
        flog.debug('BUFFER', `Opus action HIDDEN (delegates pending, not @tous)`, {
          agent: 'opus',
        });
        return;
      }
    }

    if (
      ctx.opusAllMode &&
      ctx.opusAllModeResponded &&
      ctx.delegates.expectedDelegateCount === 0 &&
      line.type === 'stdout'
    ) {
      flog.debug('ORCH', `Opus stdout SUPPRESSED (already responded in @tous non-delegation)`);
      return;
    }

    cb.onAgentOutput('opus', line);
  });

  // ── Opus status handler ──
  ctx.opus.onStatusChange((s: AgentStatus) => {
    flog.info('AGENT', `opus: ${s}`, { agent: 'opus' });
    if (ctx.stopping) {
      cb.onAgentStatus('opus', s);
      return;
    }
    if (s === 'waiting' || s === 'stopped' || s === 'error') {
      ctx.relay.flushRelayDraft('opus');
    }

    // @tous: Opus finished without delegating → simple question
    if (
      s === 'waiting' &&
      ctx.opusAllMode &&
      ctx.delegates.expectedDelegateCount === 0 &&
      !ctx.opusAllModeResponded
    ) {
      ctx.opusAllModeResponded = true;
      flog.info('ORCH', '@tous: Opus responded without delegating — sending to workers now');
      if (ctx.opusAllModeWorkerTimer) {
        clearTimeout(ctx.opusAllModeWorkerTimer);
        ctx.opusAllModeWorkerTimer = null;
      }
      if (ctx.opusAllModePendingText) {
        ctx.sendToWorkersDirectly(ctx.opusAllModePendingText);
        ctx.opusAllModePendingText = null;
      }
    }

    // Safety-net: Opus finished without routing LIVE message
    if (s === 'waiting' && ctx.relay.liveRelayAllowed) {
      ctx.relay.liveRelayAllowed = false;
      flog.warn('ORCH', 'Opus finished without routing LIVE message — injecting directly');
      for (const delegate of ctx.relay.getAgentsOnRelay()) {
        const delegateAgent = ctx.agents[delegate];
        if (delegateAgent.status === 'running' || delegateAgent.status === 'compacting') {
          const history = ctx.bus.getHistory();
          let lastUserMsg: (typeof history)[number] | undefined;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].from === 'user' && history[i].to === 'opus') {
              lastUserMsg = history[i];
              break;
            }
          }
          if (lastUserMsg) {
            flog.info('ORCH', `Fallback LIVE inject to ${delegate}`);
            delegateAgent.sendUrgent(`[LIVE MESSAGE DU USER] ${lastUserMsg.content}`);
          }
        }
      }
    }

    cb.onAgentStatus('opus', s);
    if (s === 'running') ctx.opusRestartCount = 0;

    // Auto-restart Opus on error
    if (s === 'error' && ctx.started && !ctx.opusRestartPending) {
      if (ctx.opusRestartCount >= ctx.MAX_OPUS_RESTARTS) {
        flog.error('ORCH', `Opus restart limit reached (${ctx.MAX_OPUS_RESTARTS})`);
        cb.onAgentOutput('opus', {
          text: `Opus: restart limite atteinte (${ctx.MAX_OPUS_RESTARTS})`,
          timestamp: Date.now(),
          type: 'info',
        });
        return;
      }
      ctx.opusRestartPending = true;
      const backoffDelay =
        loadUserConfig().opusRestartBaseDelayMs * Math.pow(2, ctx.opusRestartCount);
      flog.info(
        'ORCH',
        `Opus restart scheduled in ${backoffDelay}ms (attempt ${ctx.opusRestartCount + 1}/${ctx.MAX_OPUS_RESTARTS})`,
      );
      ctx.opusRestartTimer = setTimeout(async () => {
        ctx.opusRestartTimer = null;
        ctx.opusRestartPending = false;
        if (!ctx.started || !ctx.config) return;
        ctx.opusRestartCount++;
        flog.warn('ORCH', `Opus crashed — auto-restarting (attempt ${ctx.opusRestartCount})...`);
        cb.onAgentOutput('opus', {
          text: `Opus redémarrage en cours (tentative ${ctx.opusRestartCount})...`,
          timestamp: Date.now(),
          type: 'info',
        });
        try {
          await ctx.opus.start(
            { ...ctx.config!, task: '' },
            getOpusSystemPrompt(ctx.config!.projectDir),
          );
        } catch (e) {
          flog.error('ORCH', `Opus restart failed: ${e}`);
        }
      }, backoffDelay);
    }
  });

  // ── Worker agents ──
  bindWorkerAgent(ctx, 'sonnet', ctx.agents.sonnet, cb);
  bindWorkerAgent(ctx, 'codex', ctx.agents.codex, cb);

  // ── Relay events ──
  onBus('relay', (msg: unknown) => {
    const m = msg as Message;
    flog.info('RELAY', `${m.from}->${m.to}`, {
      from: m.from,
      to: m.to,
      preview: m.content.slice(0, 100),
    });
    cb.onRelay(m);
  });
  onBus('relay-blocked', (msg: unknown) => {
    const m = msg as Message;
    flog.warn('RELAY', `Blocked: ${m.from}->${m.to}`, { from: m.from, to: m.to });
    cb.onRelayBlocked(m);
  });

  // ── Route messages to Opus ──
  onBus('message:opus', (raw: unknown) => {
    const msg = raw as Message;
    flog.debug('BUS', `${msg.from}->${msg.to}`, { preview: msg.content.slice(0, 100) });
    if (msg.from === 'opus') return;
    ctx.opusQueue.add(() => {
      if (!ctx.started) return Promise.resolve();
      const prefix = `[FROM:${msg.from.toUpperCase()}]`;
      const context = getNewContext(ctx, 'opus');
      let payload = `${prefix} ${msg.content}`;
      if (context) payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
      payload = `${getOpusContextReminder(ctx)}\n\n${payload}`;
      ctx.opus.send(payload);
      return Promise.resolve();
    });
  });

  // ── Route messages to workers (lazy start) ──
  bindWorkerRoute(ctx, 'sonnet', ctx.sonnetQueue);
  bindWorkerRoute(ctx, 'codex', ctx.codexQueue);
}
