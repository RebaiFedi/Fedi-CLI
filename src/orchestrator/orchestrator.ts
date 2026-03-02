import PQueue from 'p-queue';
import type {
  AgentProcess,
  AgentId,
  AgentStatus,
  Message,
  OutputLine,
  SessionConfig,
} from '../agents/types.js';
import { SonnetAgent } from '../agents/sonnet.js';
import { CodexAgent } from '../agents/codex.js';
import { OpusAgent } from '../agents/opus.js';
import { MessageBus } from './message-bus.js';
import {
  getSonnetSystemPrompt,
  getCodexSystemPrompt,
  getOpusSystemPrompt,
  getCodexContextReminder,
  buildOpusAllModeUserMessage,
} from './prompts.js';
import { flog } from '../utils/log.js';
import { SessionManager } from '../utils/session-manager.js';
import { loadUserConfig } from '../config/user-config.js';
import { ensureClaudeMd } from './claude-md-manager.js';
import { CrossTalkManager } from './cross-talk-manager.js';
import { BufferManager } from './buffer-manager.js';
import { DelegateTracker } from './delegate-tracker.js';
import { RelayRouter } from './relay-router.js';

// ── Public interfaces ──

export interface OrchestratorDeps {
  opus?: AgentProcess;
  sonnet?: AgentProcess;
  codex?: AgentProcess;
  bus?: MessageBus;
}

export interface OrchestratorCallbacks {
  onAgentOutput: (agent: AgentId, line: OutputLine) => void;
  onAgentStatus: (agent: AgentId, status: AgentStatus) => void;
  onRelay: (msg: Message) => void;
  onRelayBlocked: (msg: Message) => void;
}

type WorkerAgentId = 'sonnet' | 'codex';

// ── Orchestrator ──

export class Orchestrator {
  readonly opus: AgentProcess;
  readonly sonnet: AgentProcess;
  readonly codex: AgentProcess;
  readonly bus: MessageBus;
  private readonly agents: Record<AgentId, AgentProcess>;
  private enabledAgents: Set<AgentId> = new Set(['opus', 'sonnet', 'codex']);

  // ── Modules ──
  private readonly crossTalk: CrossTalkManager;
  private readonly buffers: BufferManager;
  private readonly delegates: DelegateTracker;
  private readonly relay: RelayRouter;

  // ── Queues & lifecycle ──
  private opusQueue = new PQueue({ concurrency: 1 });
  private sonnetQueue = new PQueue({ concurrency: 1 });
  private codexQueue = new PQueue({ concurrency: 1 });
  private callbacks: OrchestratorCallbacks | null = null;
  private started = false;
  private config: Omit<SessionConfig, 'task'> | null = null;
  private sessionManager: SessionManager | null = null;
  private sessionMessageHandler: ((msg: Message) => void) | null = null;

  // ── Worker startup ──
  private workerStarted: Map<WorkerAgentId, boolean> = new Map([
    ['sonnet', false],
    ['codex', false],
  ]);
  private workerReady: Map<WorkerAgentId, Promise<void>> = new Map([
    ['sonnet', Promise.resolve()],
    ['codex', Promise.resolve()],
  ]);

  // ── Opus restart ──
  private opusRestartPending = false;
  private opusRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private opusRestartCount = 0;
  private readonly MAX_OPUS_RESTARTS = 3;

  // ── Context tracking ──
  private agentLastContextIndex: Map<AgentId, number> = new Map([
    ['opus', 0],
    ['sonnet', 0],
    ['codex', 0],
  ]);

  // ── Cross-talk deferred timers (tracked for cleanup) ──
  private crossTalkDeferredTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  // ── @tous mode ──
  private opusAllMode = false;
  private opusAllModeResponded = false;
  private opusAllModeWorkerTimer: ReturnType<typeof setTimeout> | null = null;
  private opusAllModePendingText: string | null = null;

  constructor(deps?: OrchestratorDeps) {
    this.opus = deps?.opus ?? new OpusAgent();
    this.sonnet = deps?.sonnet ?? new SonnetAgent();
    this.codex = deps?.codex ?? new CodexAgent();
    this.bus = deps?.bus ?? new MessageBus();
    this.agents = { opus: this.opus, sonnet: this.sonnet, codex: this.codex };

    // Initialize modules
    this.crossTalk = new CrossTalkManager();
    this.buffers = new BufferManager();
    this.delegates = new DelegateTracker({
      agents: this.agents,
      bus: this.bus,
      crossTalk: this.crossTalk,
      buffers: this.buffers,
      getCallbacks: () => this.callbacks,
      isAgentEnabled: (id) => this.isAgentEnabled(id),
    });
    this.relay = new RelayRouter({
      agents: this.agents,
      bus: this.bus,
      delegates: this.delegates,
      crossTalk: this.crossTalk,
      buffers: this.buffers,
      getCallbacks: () => this.callbacks,
      isAgentEnabled: (id) => this.isAgentEnabled(id),
      onOpusDelegated: () => {
        if (this.opusAllMode && this.opusAllModeWorkerTimer) {
          clearTimeout(this.opusAllModeWorkerTimer);
          this.opusAllModeWorkerTimer = null;
          this.opusAllModePendingText = null;
          flog.info('ORCH', '@tous: Opus delegated — cancelled worker direct-send timer');
        }
      },
    });
  }

  // ── Configuration ──

  setConfig(config: Omit<SessionConfig, 'task'>): void {
    this.config = config;
    this.sessionManager = new SessionManager(config.projectDir);
  }

  setEnabledAgents(agents: Iterable<AgentId>): void {
    const next = new Set<AgentId>(['opus']);
    for (const agent of agents) {
      if (agent === 'opus' || agent === 'sonnet' || agent === 'codex') {
        next.add(agent);
      }
    }
    this.enabledAgents = next;
    flog.info('ORCH', `Enabled agents: ${[...this.enabledAgents].join(', ')}`);
  }

  getSessionManager(): SessionManager | null {
    return this.sessionManager;
  }

  private isAgentEnabled(agentId: AgentId): boolean {
    return this.enabledAgents.has(agentId);
  }

  get isStarted(): boolean {
    return this.started;
  }

  get hasPendingDelegates(): boolean {
    return this.delegates.hasPendingDelegates;
  }

  // ── Context ──

  private getNewContext(agent: AgentId): string {
    const sinceIndex = this.agentLastContextIndex.get(agent) ?? 0;
    const { summary, newIndex } = this.bus.getContextSummary(agent, sinceIndex);
    this.agentLastContextIndex.set(agent, newIndex);
    return summary;
  }

  private getOpusContextReminder(): string {
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

    if (this.delegates.expectedDelegateCount > 0) {
      const agentNames = this.delegates
        .getExpectedDelegates()
        .map((a) => a.charAt(0).toUpperCase() + a.slice(1))
        .join(' et ');
      const received = this.delegates.pendingReportCount;
      const total = this.delegates.expectedDelegateCount;
      lines.push(
        `- MAINTENANT: ${agentNames} travaille(nt) (${received}/${total} rapports recus). ATTENDS en silence. AUCUN outil.`,
      );

      const activeOnRelay = this.relay.getAgentsOnRelay().filter((a) => {
        const s = this.agents[a].status;
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

  private getWorkerContextReminder(agentId: string, fromAgent: string): string {
    const from = fromAgent.toUpperCase();
    const peer = agentId === 'sonnet' ? 'Codex' : 'Sonnet';
    const role = agentId === 'sonnet' ? 'ingenieur frontend' : 'ingenieur backend';
    const name = agentId === 'sonnet' ? 'Sonnet' : 'Codex';
    const hasReported = this.delegates.hasPendingReport(agentId as AgentId);

    if (hasReported) {
      return `[RAPPEL] Tu es ${name}, ${role}. Tu as DEJA envoye ton rapport [TO:OPUS]. Ta tache est TERMINEE. NE REPONDS PLUS a aucun message. NE parle PAS a ${peer}. SILENCE TOTAL. Chaque message supplementaire BLOQUE le systeme.`;
    }
    if (from === 'OPUS') {
      return `[RAPPEL] Tu es ${name}, ${role}. Dis BRIEVEMENT ce que tu vas faire (1-2 phrases), puis FAIS LE TRAVAIL (Write, Edit, Bash...), puis QUAND TU AS FINI envoie [TO:OPUS] avec le resume. [TO:OPUS] = DERNIERE action, JAMAIS la premiere. Ne parle PAS au user. APRES [TO:OPUS]: SILENCE TOTAL, ne parle plus a ${peer}.`;
    }
    if (from === 'USER') {
      return `[RAPPEL] Tu es ${name}, ${role}. Le user te parle directement. Reponds au user. PAS de [TO:OPUS].`;
    }
    if (from === peer.toUpperCase()) {
      return `[RAPPEL] Tu es ${name}, ${role}. ${peer} te parle — reponds avec des INFOS TECHNIQUES utiles. Quand la coordination est finie, envoie [TO:OPUS] avec ton rapport. APRES [TO:OPUS]: SILENCE TOTAL, plus de messages a ${peer}. PAS de politesses, PAS de "merci", PAS de "bonne continuation".`;
    }
    return '';
  }

  // ── Binding ──

  bind(cb: OrchestratorCallbacks): void {
    this.callbacks = cb;

    // Clear all previous handlers to prevent duplicates on re-bind
    this.opus.clearHandlers();
    for (const agent of Object.values(this.agents)) {
      agent.clearHandlers();
    }

    // Opus output handler
    this.opus.onOutput((line) => {
      flog.debug('AGENT', 'Output', {
        agent: 'opus',
        type: line.type,
        text: line.text.slice(0, 150),
      });
      const delegatesBefore = this.delegates.expectedDelegateCount;
      const { foundRelayTag, preTagLines } = this.relay.detectRelayPatterns('opus', line.text);

      // Emit pre-tag conversational lines that Opus wrote before [TO:*] tags.
      // These are text the user should see (e.g. "Alright ! Let's go.")
      // They must be emitted BEFORE the buffering check because detectRelayPatterns
      // may have added new delegates, causing the buffer check to swallow them.
      if (preTagLines.length > 0 && delegatesBefore === 0 && line.type === 'stdout') {
        const preTagText = preTagLines.join('\n');
        flog.debug('ORCH', `Opus pre-tag text emitted: ${preTagText.slice(0, 100)}`);
        cb.onAgentOutput('opus', {
          text: preTagText,
          timestamp: line.timestamp,
          type: 'stdout',
        });
        // If no relay tags were found, the entire text was pre-tag — already emitted above.
        // Skip the final cb.onAgentOutput to avoid displaying the same text twice.
        if (!foundRelayTag) return;
      }

      if (this.delegates.expectedDelegateCount > 0) {
        if (line.type === 'stdout') {
          const stripped = line.text.replace(/\[TASK:(add|done)\][^\n]*/gi, '').trim();
          if (stripped.length > 0) {
            flog.debug(
              'BUFFER',
              `Opus stdout BUFFERED (${this.delegates.expectedDelegateCount} delegates pending)`,
              { agent: 'opus' },
            );
            this.buffers.pushToBuffer('opus', line);
            this.buffers.maybeEmitStatusSnippet('opus', line.text, cb);
            return;
          }
        }
        if (!this.opusAllMode && line.type === 'system') {
          flog.debug('BUFFER', `Opus action HIDDEN (delegates pending, not @tous)`, {
            agent: 'opus',
          });
          return;
        }
      }

      if (
        this.opusAllMode &&
        this.opusAllModeResponded &&
        this.delegates.expectedDelegateCount === 0 &&
        line.type === 'stdout'
      ) {
        flog.debug('ORCH', `Opus stdout SUPPRESSED (already responded in @tous non-delegation)`);
        return;
      }

      cb.onAgentOutput('opus', line);
    });

    // Opus status handler
    this.opus.onStatusChange((s) => {
      flog.info('AGENT', `opus: ${s}`, { agent: 'opus' });
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        this.relay.flushRelayDraft('opus');
      }

      // @tous: Opus finished without delegating → simple question
      if (
        s === 'waiting' &&
        this.opusAllMode &&
        this.delegates.expectedDelegateCount === 0 &&
        !this.opusAllModeResponded
      ) {
        this.opusAllModeResponded = true;
        flog.info('ORCH', '@tous: Opus responded without delegating — sending to workers now');
        if (this.opusAllModeWorkerTimer) {
          clearTimeout(this.opusAllModeWorkerTimer);
          this.opusAllModeWorkerTimer = null;
        }
        if (this.opusAllModePendingText) {
          this.sendToWorkersDirectly(this.opusAllModePendingText);
          this.opusAllModePendingText = null;
        }
      }

      // Safety-net: Opus finished without routing LIVE message
      if (s === 'waiting' && this.relay.liveRelayAllowed) {
        this.relay.liveRelayAllowed = false;
        flog.warn('ORCH', 'Opus finished without routing LIVE message — injecting directly');
        for (const delegate of this.relay.getAgentsOnRelay()) {
          const delegateAgent = this.agents[delegate];
          if (delegateAgent.status === 'running' || delegateAgent.status === 'compacting') {
            const history = this.bus.getHistory();
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
      if (s === 'running') this.opusRestartCount = 0;

      // Auto-restart Opus on error
      if (s === 'error' && this.started && !this.opusRestartPending) {
        if (this.opusRestartCount >= this.MAX_OPUS_RESTARTS) {
          flog.error('ORCH', `Opus restart limit reached (${this.MAX_OPUS_RESTARTS})`);
          cb.onAgentOutput('opus', {
            text: `Opus: restart limite atteinte (${this.MAX_OPUS_RESTARTS})`,
            timestamp: Date.now(),
            type: 'info',
          });
          return;
        }
        this.opusRestartPending = true;
        const backoffDelay =
          loadUserConfig().opusRestartBaseDelayMs * Math.pow(2, this.opusRestartCount);
        flog.info(
          'ORCH',
          `Opus restart scheduled in ${backoffDelay}ms (attempt ${this.opusRestartCount + 1}/${this.MAX_OPUS_RESTARTS})`,
        );
        this.opusRestartTimer = setTimeout(async () => {
          this.opusRestartTimer = null;
          this.opusRestartPending = false;
          if (!this.started || !this.config) return;
          this.opusRestartCount++;
          flog.warn('ORCH', `Opus crashed — auto-restarting (attempt ${this.opusRestartCount})...`);
          cb.onAgentOutput('opus', {
            text: `Opus redémarrage en cours (tentative ${this.opusRestartCount})...`,
            timestamp: Date.now(),
            type: 'info',
          });
          try {
            await this.opus.start(
              { ...this.config, task: '' },
              getOpusSystemPrompt(this.config.projectDir),
            );
          } catch (e) {
            flog.error('ORCH', `Opus restart failed: ${e}`);
          }
        }, backoffDelay);
      }
    });

    // Bind worker agents
    this.bindWorkerAgent('sonnet', this.sonnet, cb);
    this.bindWorkerAgent('codex', this.codex, cb);

    // Relay events
    this.bus.on('relay', (msg: Message) => {
      flog.info('RELAY', `${msg.from}->${msg.to}`, {
        from: msg.from,
        to: msg.to,
        preview: msg.content.slice(0, 100),
      });
      cb.onRelay(msg);
    });
    this.bus.on('relay-blocked', (msg: Message) => {
      flog.warn('RELAY', `Blocked: ${msg.from}->${msg.to}`, { from: msg.from, to: msg.to });
      cb.onRelayBlocked(msg);
    });

    // Route messages to Opus
    this.bus.on('message:opus', (msg: Message) => {
      flog.debug('BUS', `${msg.from}->${msg.to}`, { preview: msg.content.slice(0, 100) });
      if (msg.from === 'opus') return;
      this.opusQueue.add(() => {
        if (!this.started) return Promise.resolve();
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        const context = this.getNewContext('opus');
        let payload = `${prefix} ${msg.content}`;
        if (context) payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
        payload = `${this.getOpusContextReminder()}\n\n${payload}`;
        this.opus.send(payload);
        return Promise.resolve();
      });
    });

    // Route messages to workers (lazy start)
    this.bindWorkerRoute(
      'sonnet',
      this.sonnetQueue,
      () => this.ensureWorkerStarted('sonnet'),
      () => this.workerReady.get('sonnet') ?? Promise.resolve(),
    );
    this.bindWorkerRoute(
      'codex',
      this.codexQueue,
      () => this.ensureWorkerStarted('codex'),
      () => this.workerReady.get('codex') ?? Promise.resolve(),
    );
  }

  private bindWorkerRoute(
    agentId: WorkerAgentId,
    queue: PQueue,
    ensureStarted: () => Promise<void>,
    readyPromise: () => Promise<void>,
  ): void {
    this.bus.on(`message:${agentId}`, (msg: Message) => {
      if (!this.isAgentEnabled(agentId)) return;
      flog.debug('BUS', `${msg.from}->${msg.to}`, { preview: msg.content.slice(0, 100) });
      if (msg.from === agentId) return;
      if (msg.from !== 'opus' && msg.from !== 'user' && this.crossTalk.isAwaitingReply(agentId)) {
        flog.info(
          'ORCH',
          `${agentId} received cross-talk reply from ${msg.from} — no longer awaiting`,
        );
        this.crossTalk.clearAwaitingReply(agentId);
      }
      queue.add(async () => {
        if (!this.started) return;
        await ensureStarted();
        void readyPromise();
        if (!this.started) return;
        if (this.crossTalk.isOnCrossTalk(agentId)) {
          this.crossTalk.setOnCrossTalk(agentId, Date.now());
        }
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        const context = this.getNewContext(agentId);
        let payload = `${prefix} ${msg.content}`;
        if (context) payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
        const workerReminder = this.getWorkerContextReminder(agentId, msg.from);
        if (workerReminder) payload = `${workerReminder}\n\n${payload}`;
        this.agents[agentId].send(payload);
      });
    });
  }

  private bindWorkerAgent(agentId: AgentId, agent: AgentProcess, cb: OrchestratorCallbacks): void {
    const label = agentId.charAt(0).toUpperCase() + agentId.slice(1);
    const cfg = loadUserConfig();
    const crossTalkMuteTimeout = cfg.crossTalkMuteTimeoutMs;
    const crossTalkClearThreshold = cfg.crossTalkClearThresholdMs;

    agent.onOutput((line) => {
      flog.debug('AGENT', 'Output', {
        agent: agentId,
        type: line.type,
        text: line.text.slice(0, 150),
      });
      this.delegates.recordActivity(agentId);

      if (line.type === 'stdout' && line.text.includes('API Error:')) {
        flog.warn('ORCH', `${label} API error detected`);
        cb.onAgentOutput(agentId, {
          text: `${label}: limite de tokens atteinte — reprise en cours...`,
          timestamp: Date.now(),
          type: 'info',
        });
      }

      if (this.delegates.isDeliveredToOpus(agentId)) {
        flog.debug('ORCH', `${label} output MUTED (delivered to Opus, type=${line.type})`);
        return;
      }

      if (this.opusAllMode && this.delegates.expectedDelegateCount > 0 && line.type === 'stdout') {
        flog.debug('ORCH', `${label} stdout BLOCKED (@tous delegation active)`);
        this.relay.detectRelayPatterns(agentId, line.text); // preTagLines unused for workers
        this.buffers.pushToBuffer(agentId, line);
        this.buffers.maybeEmitStatusSnippet(agentId, line.text, cb);
        return;
      }

      if (line.type === 'checkpoint') {
        cb.onAgentOutput(agentId, line);
        return;
      }

      if (this.delegates.hasPendingReport(agentId) && line.type === 'stdout') {
        flog.debug('ORCH', `${label} output MUTED (already reported to Opus)`);
        this.relay.detectRelayPatterns(agentId, line.text);
        return;
      }

      // Cross-talk mute handling
      if (this.crossTalk.isOnCrossTalk(agentId)) {
        const muteTime = this.crossTalk.getCrossTalkTime(agentId)!;
        if (Date.now() - muteTime > crossTalkMuteTimeout) {
          flog.warn(
            'ORCH',
            `${label} cross-talk mute timeout (${crossTalkMuteTimeout / 1000}s) — unmuting`,
          );
          this.crossTalk.clearOnCrossTalk(agentId);
        } else {
          this.relay.detectRelayPatterns(agentId, line.text);
          if (this.relay.isOnRelay(agentId) && line.type !== 'stdout' && line.type !== 'stderr') {
            this.relay.setRelayStart(agentId, Date.now());
          }
          if (this.relay.isOnRelay(agentId) && line.type === 'stdout') {
            flog.debug('BUFFER', 'On cross-talk + relay for opus', { agent: agentId });
            if (/\[TASK:(add|done)\]/i.test(line.text)) cb.onAgentOutput(agentId, line);
            this.buffers.pushToBuffer(agentId, line);
            this.buffers.maybeEmitStatusSnippet(agentId, line.text, cb);
          }
          if (line.type !== 'stdout') cb.onAgentOutput(agentId, line);
          return;
        }
      }

      // On relay — buffer stdout, pass actions
      if (this.relay.isOnRelay(agentId)) {
        if (line.type !== 'stdout' && line.type !== 'stderr') {
          this.relay.setRelayStart(agentId, Date.now());
        }
        const start = this.relay.getRelayStart(agentId) ?? 0;
        const elapsed = Date.now() - start;
        const relayTimeout = this.relay.getRelayTimeout(agentId);
        const isActive = agent.status === 'running' || agent.status === 'compacting';

        if (relayTimeout > 0 && elapsed > relayTimeout && !isActive) {
          flog.warn(
            'ORCH',
            `${label} relay timeout (${Math.round(elapsed / 1000)}s) — forcing auto-relay`,
          );
          this.delegates.autoRelayBuffer(agentId, this.relay);
        } else {
          if (relayTimeout > 0 && elapsed > relayTimeout && isActive) {
            flog.debug(
              'ORCH',
              `${label} relay past timeout but agent still running — NOT timing out`,
            );
          }
          this.relay.detectRelayPatterns(agentId, line.text);
          if (line.type === 'stdout') {
            flog.debug('BUFFER', 'On relay for opus', { agent: agentId });
            if (/\[TASK:(add|done)\]/i.test(line.text)) cb.onAgentOutput(agentId, line);
            this.buffers.pushToBuffer(agentId, line);
            this.buffers.maybeEmitStatusSnippet(agentId, line.text, cb);
          } else {
            cb.onAgentOutput(agentId, line);
          }
          return;
        }
      }

      const { foundRelayTag } = this.relay.detectRelayPatterns(agentId, line.text);
      if (!foundRelayTag) cb.onAgentOutput(agentId, line);
    });

    agent.onStatusChange((s) => {
      flog.info('AGENT', `${agentId}: ${s}`, { agent: agentId });
      this.delegates.recordActivity(agentId);

      if (s === 'running') {
        this.delegates.clearSafetyNetTimer(agentId);
      }
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        this.relay.flushRelayDraft(agentId);
      }

      // Cross-talk mute clearing
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        const muteTime = this.crossTalk.getCrossTalkTime(agentId);
        if (muteTime !== undefined) {
          const elapsed = Date.now() - muteTime;
          if (elapsed > crossTalkClearThreshold || s === 'stopped' || s === 'error') {
            flog.info(
              'ORCH',
              `Cross-talk MUTE CLEARED for ${agentId} (status=${s}, elapsed=${elapsed}ms)`,
            );
            this.crossTalk.clearOnCrossTalk(agentId);
            if (this.delegates.allReportsReceived()) {
              this.delegates.deliverCombinedReports();
            }
          } else {
            flog.info(
              'ORCH',
              `Cross-talk mute kept for ${agentId} (status=${s}, elapsed=${elapsed}ms — too soon)`,
            );
            const remaining = crossTalkClearThreshold - elapsed + 50;
            const deferredTimer = setTimeout(() => {
              this.crossTalkDeferredTimers.delete(deferredTimer);
              if (!this.crossTalk.isOnCrossTalk(agentId)) return;
              flog.info('ORCH', `Cross-talk MUTE CLEARED for ${agentId} (deferred timer fired)`);
              this.crossTalk.clearOnCrossTalk(agentId);
              if (this.delegates.allReportsReceived()) {
                this.delegates.deliverCombinedReports();
              }
            }, remaining);
            this.crossTalkDeferredTimers.add(deferredTimer);
          }
        }
      }

      // Agent stopped/error — handle fallback
      if (s === 'stopped' || s === 'error') {
        flog.info('RELAY', `${agentId}: end`, { agent: agentId, detail: `status=${s}` });
        this.relay.removeFromRelay(agentId);
        this.buffers.clearBuffer(agentId);
        this.relay.removeRelayStart(agentId);

        if (
          this.delegates.isExpectedDelegate(agentId) &&
          !this.delegates.hasPendingReport(agentId)
        ) {
          const originalTask = this.delegates.getLastDelegation(agentId);
          const fallback = this.delegates.pickFallbackAgent(agentId);

          if (fallback && fallback !== 'opus' && originalTask) {
            flog.info('ORCH', `Agent ${agentId} ${s} — fallback to ${fallback}`);
            this.delegates.addExpectedDelegate(fallback);
            this.delegates.removeDeliveredToOpus(fallback);
            this.relay.addOnRelay(fallback);
            this.relay.setRelayStart(fallback, Date.now());
            this.delegates.setLastDelegation(fallback, originalTask);
            this.delegates.recordActivity(fallback);
            this.relay.recordRelay();
            this.bus.relay('opus', fallback, `[FALLBACK — ${agentId} ${s}] ${originalTask}`);
            cb.onAgentOutput(agentId, {
              text: `${agentId} ${s} — tache transferee a ${fallback}`,
              timestamp: Date.now(),
              type: 'info',
            });
          } else if (fallback === 'opus' && originalTask) {
            flog.info('ORCH', `Agent ${agentId} ${s}, no worker fallback — Opus takes over`);
            this.delegates.clearExpectedDelegates();
            this.delegates.clearPendingReports();
            this.delegates.stopHeartbeat();
            this.bus.send({
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
            this.delegates.setPendingReport(agentId, `(agent ${s} — pas de rapport)`);
            if (this.delegates.allReportsReceived()) {
              this.delegates.deliverCombinedReports();
            }
          }
        }

        if (!this.relay.isOpusWaitingForRelays() && this.delegates.expectedDelegateCount === 0) {
          this.buffers.flushOpusBuffer(cb);
        }
      }

      // Safety-net auto-relay
      if (
        s === 'waiting' &&
        this.relay.isOnRelay(agentId) &&
        !this.crossTalk.isAwaitingReply(agentId)
      ) {
        const timer = setTimeout(() => {
          if (!this.relay.isOnRelay(agentId) || this.delegates.hasPendingReport(agentId)) return;
          const agentInstance = this.agents[agentId];
          if (agentInstance.status === 'running' || agentInstance.status === 'compacting') {
            flog.info(
              'ORCH',
              `Safety-net deferred for ${agentId} — agent still ${agentInstance.status}`,
            );
            return;
          }
          this.delegates.autoRelayBuffer(agentId, this.relay);
        }, loadUserConfig().safetyNetDebounceMs);
        this.delegates.setSafetyNetTimer(agentId, timer);
      }

      cb.onAgentStatus(agentId, s);
    });
  }

  // ── Worker startup ──

  private async ensureWorkerStarted(agentId: WorkerAgentId): Promise<void> {
    if (!this.config || !this.isAgentEnabled(agentId)) return;
    const existing = this.workerReady.get(agentId) ?? Promise.resolve();
    if (this.workerStarted.get(agentId)) {
      await existing;
      return;
    }

    this.workerStarted.set(agentId, true);
    const config = this.config;

    let prompt = '';
    let agent: AgentProcess;
    if (agentId === 'sonnet') {
      flog.info('ORCH', 'Lazy-starting Sonnet...');
      prompt = getSonnetSystemPrompt(config.projectDir);
      agent = this.sonnet;
    } else if (agentId === 'codex') {
      flog.info('ORCH', 'Lazy-starting Codex...');
      prompt = getCodexSystemPrompt(config.projectDir);
      this.codex.setContextReminder?.(getCodexContextReminder(config.projectDir));
      agent = this.codex;
    } else {
      return;
    }

    const { summary, newIndex } = this.bus.getContextSummary(agentId, 0, 5);
    this.agentLastContextIndex.set(agentId, newIndex);
    if (summary) prompt += `\n\n--- HISTORIQUE ---\n${summary}\n--- FIN ---`;

    const ready = agent.start({ ...config, task: '' }, prompt);
    this.workerReady.set(agentId, ready);
    await ready;
  }

  // ── Lifecycle ──

  async startWithTask(task: string, previousContext?: string): Promise<void> {
    if (this.started || !this.config) return;
    this.stopping = false;
    const config = this.config;
    flog.info('ORCH', `Starting Opus with task: ${task.slice(0, 80)}`);

    ensureClaudeMd(config.projectDir);
    await this.sessionManager?.createSession(task, config.projectDir);

    if (this.sessionMessageHandler) this.bus.off('message', this.sessionMessageHandler);
    this.sessionMessageHandler = (msg: Message) => this.sessionManager?.addMessage(msg);
    this.bus.on('message', this.sessionMessageHandler);

    let opusPrompt = getOpusSystemPrompt(config.projectDir);
    if (previousContext)
      opusPrompt += `\n\n--- HISTORIQUE SESSION PRECEDENTE ---\n${previousContext}\n--- FIN HISTORIQUE ---`;
    opusPrompt += `\n\nMESSAGE DU USER: ${task}`;

    this.opusQueue.start();
    this.sonnetQueue.start();
    this.codexQueue.start();

    await this.opus.start({ ...config, task }, opusPrompt);
    this.started = true;

    if (this.opus.getSessionId()) {
      const resumeMsg = previousContext
        ? `[NOUVELLE TACHE DU USER] ${task}\n\n[RESET] La session precedente a ete INTERROMPUE par le user (Echap). TOUS les agents (Sonnet, Codex) ont ete STOPPES. Tes delegations precedentes sont ANNULEES — aucun agent ne travaille. Si le user demande une action sur le code/projet, tu DOIS re-deleguer. Ne dis PAS "c'est en cours" ou "j'ai deja lance" — c'est FAUX, les agents sont morts.`
        : `[NOUVELLE TACHE DU USER] ${task}`;
      this.opus.send(resumeMsg);
      flog.info('ORCH', 'Opus resumed session — sent new task as follow-up');
    }

    flog.info('ORCH', 'Opus started (Sonnet, Codex on standby — lazy start)');
  }

  async restart(task: string): Promise<void> {
    const previousContext = this.buildConversationSummary();
    await this.sessionManager?.finalize();
    this.resetState();

    if (this.sessionMessageHandler) {
      this.bus.off('message', this.sessionMessageHandler);
      this.sessionMessageHandler = null;
    }
    this.bus.reset();
    flog.info(
      'ORCH',
      `Restarting with context (${previousContext ? previousContext.length : 0} chars)`,
    );
    await this.startWithTask(task, previousContext || undefined);
  }

  private buildConversationSummary(): string | null {
    const history = this.bus.getHistory();
    if (history.length === 0) return null;
    const recent = history.slice(-30);
    const lines: string[] = [];
    for (const msg of recent) {
      const content = msg.content.length > 300 ? msg.content.slice(0, 300) + '...' : msg.content;
      lines.push(`[${msg.from.toUpperCase()} -> ${msg.to.toUpperCase()}] ${content}`);
    }
    return lines.join('\n');
  }

  // ── User messaging ──

  sendUserMessage(text: string): void {
    this.opusAllMode = false;
    this.relay.clearDirectMode();
    if (this.callbacks) this.buffers.flushOpusBuffer(this.callbacks);

    if (this.relay.hasAnyOnRelay()) {
      this.relay.liveRelayAllowed = true;
      flog.info(
        'ORCH',
        `User message while ${this.relay.getAgentsOnRelay().join(', ')} on relay — Opus will route LIVE`,
      );
    }

    if (this.opus.status === 'running' || this.opus.status === 'compacting') {
      this.sendUserMessageLive(text, 'opus');
    } else {
      this.bus.send({ from: 'user', to: 'opus', content: text });
    }
  }

  sendUserMessageLive(text: string, target: AgentId): void {
    const agent = this.agents[target];
    if (agent.status === 'running' || agent.status === 'compacting') {
      const reminder = target === 'opus' ? this.getOpusContextReminder() : '';
      const prefix = reminder ? `${reminder}\n\n` : '';
      agent.sendUrgent(`${prefix}[LIVE MESSAGE DU USER] ${text}`);
      this.bus.record({ from: 'user', to: target, content: text });
    } else {
      this.bus.send({ from: 'user', to: target, content: text });
    }
  }

  setDirectMode(agent: AgentId): void {
    if (agent !== 'opus') this.relay.setDirectMode(agent);
  }

  sendToAgent(agent: AgentId, text: string): void {
    if (!this.isAgentEnabled(agent)) {
      this.callbacks?.onAgentOutput(agent, {
        text: `Agent desactive: ${agent}`,
        timestamp: Date.now(),
        type: 'info',
      });
      return;
    }
    this.relay.removeFromRelay(agent);
    this.crossTalk.clearAgent(agent);
    this.delegates.removeExpectedDelegate(agent);
    this.delegates.removePendingReport(agent);
    this.delegates.removeDeliveredToOpus(agent);

    if (this.delegates.allReportsReceived()) {
      this.delegates.deliverCombinedReports();
    }

    if (agent !== 'opus') this.relay.setDirectMode(agent);
    this.delegates.clearSafetyNetTimer(agent);

    if (this.callbacks) {
      for (const buffered of this.buffers.getBuffer(agent)) {
        this.callbacks.onAgentOutput(agent, buffered);
      }
    }
    this.buffers.clearBuffer(agent);

    const agentInstance = this.agents[agent];
    if (agentInstance.status === 'running' || agentInstance.status === 'compacting') {
      agentInstance.sendUrgent(`[FROM:USER] ${text}`);
      this.bus.record({ from: 'user', to: agent, content: text });
    } else {
      this.bus.send({ from: 'user', to: agent, content: text });
    }
  }

  sendToAllDirect(text: string): void {
    // Clear all relay state
    this.relay.clearOnRelay();
    this.crossTalk.reset();
    this.relay.clearRelayStarts();
    this.delegates.clearExpectedDelegates();
    this.delegates.clearPendingReports();
    this.delegates.clearDeliveredToOpus();
    this.relay.clearDirectMode();

    for (const agent of ['sonnet', 'codex', 'opus'] as AgentId[]) {
      if (this.callbacks) {
        for (const buffered of this.buffers.getBuffer(agent)) {
          this.callbacks.onAgentOutput(agent, buffered);
        }
      }
      this.buffers.clearBuffer(agent);
    }

    this.opusAllMode = true;
    this.opusAllModeResponded = false;

    const opusAllModeMessage = buildOpusAllModeUserMessage(text);
    const opus = this.opus;
    if (opus.status === 'running' || opus.status === 'compacting') {
      opus.sendUrgent(`[FROM:USER] ${opusAllModeMessage}`);
      this.bus.record({ from: 'user', to: 'opus', content: opusAllModeMessage });
    } else {
      this.bus.send({ from: 'user', to: 'opus', content: opusAllModeMessage });
    }

    this.opusAllModePendingText = text;
    if (this.opusAllModeWorkerTimer) clearTimeout(this.opusAllModeWorkerTimer);
    this.opusAllModeWorkerTimer = setTimeout(() => {
      this.opusAllModeWorkerTimer = null;
      if (this.opusAllModePendingText && this.delegates.expectedDelegateCount === 0) {
        flog.info('ORCH', '@tous: Opus safety-net timer (15s) — sending to workers directly');
        this.sendToWorkersDirectly(this.opusAllModePendingText);
      }
      this.opusAllModePendingText = null;
    }, 15_000);
  }

  private sendToWorkersDirectly(text: string): void {
    for (const agentId of ['sonnet', 'codex'] as AgentId[]) {
      if (!this.isAgentEnabled(agentId)) continue;
      const agent = this.agents[agentId];
      const workerMsg = `[FROM:USER] ${text}`;
      if (agent.status === 'running' || agent.status === 'compacting') {
        agent.sendUrgent(workerMsg);
        this.bus.record({ from: 'user', to: agentId, content: text });
      } else {
        this.bus.send({ from: 'user', to: agentId, content: text });
      }
    }
  }

  // ── State reset ──

  private resetState(): void {
    this.started = false;
    if (this.opusRestartTimer) {
      clearTimeout(this.opusRestartTimer);
      this.opusRestartTimer = null;
    }
    this.opusRestartPending = false;
    this.opusRestartCount = 0;
    this.workerStarted = new Map([
      ['sonnet', false],
      ['codex', false],
    ]);
    this.workerReady = new Map([
      ['sonnet', Promise.resolve()],
      ['codex', Promise.resolve()],
    ]);
    this.agentLastContextIndex = new Map([
      ['opus', 0],
      ['sonnet', 0],
      ['codex', 0],
    ]);

    this.relay.reset();
    this.crossTalk.reset();
    this.buffers.reset();
    this.delegates.reset();

    for (const t of this.crossTalkDeferredTimers) clearTimeout(t);
    this.crossTalkDeferredTimers.clear();

    this.opusAllMode = false;
    this.opusAllModeResponded = false;
    this.relay.liveRelayAllowed = false;
    if (this.opusAllModeWorkerTimer) {
      clearTimeout(this.opusAllModeWorkerTimer);
      this.opusAllModeWorkerTimer = null;
    }
    this.opusAllModePendingText = null;
  }

  // ── Shutdown ──

  private stopping = false;

  async stop(): Promise<void> {
    if (this.stopping) return; // idempotent — already shutting down
    this.stopping = true;
    flog.info('ORCH', 'Shutting down...');
    this.started = false;

    this.opusQueue.pause();
    this.sonnetQueue.pause();
    this.codexQueue.pause();
    this.opusQueue.clear();
    this.sonnetQueue.clear();
    this.codexQueue.clear();

    this.delegates.clearAllTimers();
    if (this.opusRestartTimer) {
      clearTimeout(this.opusRestartTimer);
      this.opusRestartTimer = null;
      this.opusRestartPending = false;
    }

    this.relay.clearOnRelay();
    this.crossTalk.reset();
    for (const t of this.crossTalkDeferredTimers) clearTimeout(t);
    this.crossTalkDeferredTimers.clear();
    this.delegates.clearExpectedDelegates();
    this.delegates.clearPendingReports();
    this.delegates.clearDeliveredToOpus();
    this.opusAllMode = false;
    this.opusAllModeResponded = false;
    if (this.opusAllModeWorkerTimer) {
      clearTimeout(this.opusAllModeWorkerTimer);
      this.opusAllModeWorkerTimer = null;
    }
    this.opusAllModePendingText = null;
    this.relay.clearDirectMode();
    this.relay.clearAllTimers();

    const opusSid = this.opus.getSessionId();
    const sonnetSid = this.sonnet.getSessionId();
    const codexSid = this.codex.getSessionId();
    if (opusSid) this.sessionManager?.setAgentSession('opus', opusSid);
    if (sonnetSid) this.sessionManager?.setAgentSession('sonnet', sonnetSid);
    if (codexSid) this.sessionManager?.setAgentSession('codex', codexSid);

    await Promise.allSettled([this.opus.stop(), this.sonnet.stop(), this.codex.stop()]);
    flog.info('ORCH', 'All agents stopped');

    await this.sessionManager?.finalize();
    flog.info('ORCH', 'Shutdown complete');
  }
}
