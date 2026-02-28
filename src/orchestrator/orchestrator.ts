import PQueue from 'p-queue';
import { ClaudeAgent } from '../agents/claude.js';
import { CodexAgent } from '../agents/codex.js';
import { OpusAgent } from '../agents/opus.js';
import type { AgentProcess, AgentId, AgentStatus, Message, OutputLine, SessionConfig } from '../agents/types.js';
import { TO_CLAUDE_PATTERN, TO_CODEX_PATTERN, TO_OPUS_PATTERN } from '../agents/types.js';
import { MessageBus } from './message-bus.js';
import {
  getClaudeSystemPrompt,
  getCodexSystemPrompt,
  getOpusSystemPrompt,
  getCodexContextReminder,
  buildOpusAllModeUserMessage,
} from './prompts.js';
import { flog } from '../utils/log.js';
import { SessionManager } from '../utils/session-manager.js';
import { loadUserConfig } from '../config/user-config.js';

export interface OrchestratorDeps {
  opus?: AgentProcess;
  claude?: AgentProcess;
  codex?: AgentProcess;
  bus?: MessageBus;
}

/** Max relays within a time window before blocking */
const _cfg = loadUserConfig();
const RELAY_WINDOW_MS = _cfg.relayWindowMs;
const MAX_RELAYS_PER_WINDOW = _cfg.maxRelaysPerWindow;

export interface OrchestratorCallbacks {
  onAgentOutput: (agent: AgentId, line: OutputLine) => void;
  onAgentStatus: (agent: AgentId, status: AgentStatus) => void;
  onRelay: (msg: Message) => void;
  onRelayBlocked: (msg: Message) => void;
}

type WorkerAgentId = 'claude' | 'codex';

export class Orchestrator {
  readonly opus: AgentProcess;
  readonly claude: AgentProcess;
  readonly codex: AgentProcess;
  readonly bus: MessageBus;
  private readonly agents: Record<AgentId, AgentProcess>;

  constructor(deps?: OrchestratorDeps) {
    this.opus = deps?.opus ?? new OpusAgent();
    this.claude = deps?.claude ?? new ClaudeAgent();
    this.codex = deps?.codex ?? new CodexAgent();
    this.bus = deps?.bus ?? new MessageBus();
    this.agents = {
      opus: this.opus,
      claude: this.claude,
      codex: this.codex,
    };
  }
  private opusQueue = new PQueue({ concurrency: 1 });
  private claudeQueue = new PQueue({ concurrency: 1 });
  private codexQueue = new PQueue({ concurrency: 1 });
  private callbacks: OrchestratorCallbacks | null = null;
  private started = false;
  private workerStarted: Map<WorkerAgentId, boolean> = new Map([
    ['claude', false],
    ['codex', false],
  ]);
  private workerReady: Map<WorkerAgentId, Promise<void>> = new Map([
    ['claude', Promise.resolve()],
    ['codex', Promise.resolve()],
  ]);
  private opusRestartPending = false;
  private opusRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private opusRestartCount = 0;
  private config: Omit<SessionConfig, 'task'> | null = null;
  private relayTimestamps: number[] = [];
  private sessionMessageHandler: ((msg: Message) => void) | null = null;
  private agentLastContextIndex: Map<AgentId, number> = new Map([
    ['opus', 0],
    ['claude', 0],
    ['codex', 0],
  ]);
  private sessionManager: SessionManager | null = null;
  /** Agents currently working on a relay from Opus — text output muted, actions only */
  private agentsOnRelay: Set<AgentId> = new Set();
  /** Buffer stdout while agent works on relay — flushed when relay ends */
  private relayBuffer: Map<AgentId, OutputLine[]> = new Map([
    ['claude', []],
    ['codex', []],
    ['opus', []],
  ]);
  /** Timestamp when relay started for each agent — used for safety timeout */
  private relayStartTime: Map<AgentId, number> = new Map();
  /** Agents that Opus delegated to — we wait for ALL before delivering to Opus */
  private expectedDelegates: Set<AgentId> = new Set();
  /** Buffered reports from delegates — delivered to Opus as one combined message */
  private pendingReportsForOpus: Map<AgentId, string> = new Map();
  /** Agents whose combined report has been delivered to Opus — mute ALL late output */
  private deliveredToOpus: Set<AgentId> = new Set();
  /** Pending safety-net timers for spawn-per-exec agents */
  private safetyNetTimers: Map<AgentId, ReturnType<typeof setTimeout>> = new Map();
  /** Heartbeat interval for expectedDelegates — checks if agents are still active */
  private delegateHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of last activity from each delegate (output, status change) */
  private delegateLastActivity: Map<AgentId, number> = new Map();
  /** Max idle time (ms) before a delegate is considered stuck — only triggers if agent is NOT running */
  private readonly DELEGATE_IDLE_TIMEOUT_MS = _cfg.delegateTimeoutMs;
  /** How often (ms) to check if delegates are still alive */
  private readonly DELEGATE_HEARTBEAT_INTERVAL_MS = 10_000;
  /** Grace period (ms) before safety-net auto-relay fires for spawn-per-exec agents */
  private readonly SAFETY_NET_GRACE_MS = 3_000;
  /** Relay timeout follows the same timeout used for exec-based agents */
  private readonly RELAY_TIMEOUT_MS = _cfg.execTimeoutMs;
  private readonly MAX_OPUS_RESTARTS = 3;
  /** Cross-talk message counter — reset each round, blocks after MAX */
  private crossTalkCount = 0;
  private readonly MAX_CROSS_TALK_PER_ROUND = _cfg.maxCrossTalkPerRound;
  /** Agents responding to a cross-talk message — stdout muted until timeout or next user interaction */
  private agentsOnCrossTalk: Map<AgentId, number> = new Map(); // agentId → timestamp when set
  /** Last delegation content sent to each agent — used for auto-fallback on failure */
  private lastDelegationContent: Map<AgentId, string> = new Map();
  /** Agents that INITIATED a cross-talk and are waiting for a peer response.
   *  While waiting, the safety-net auto-relay must NOT trigger. */
  private awaitingCrossTalkReply: Set<AgentId> = new Set();
  /** Stateful relay drafts to avoid truncating [TO:*] payloads across stream chunks. */
  private relayDrafts: Map<AgentId, { target: AgentId; parts: string[] }> = new Map();
  /** Debounce timers for relay drafts — flush when no new chunk arrives shortly. */
  private relayDraftTimers: Map<AgentId, ReturnType<typeof setTimeout>> = new Map();
  /** How many consecutive empty-content flushes we've deferred (per agent). */
  private relayDraftEmptyRetries: Map<AgentId, number> = new Map();
  private readonly RELAY_DRAFT_FLUSH_MS = 60;
  /** Max consecutive empty retries before we give up and flush (prevents leaks). */
  private readonly RELAY_DRAFT_MAX_EMPTY_RETRIES = 8;
  /** When true, Opus stdout is NOT buffered even when delegates are pending.
   *  Set by sendToAllDirect so the user sees Opus working in real-time (@tous mode). */
  private opusAllMode = false;

  setConfig(config: Omit<SessionConfig, 'task'>) {
    this.config = config;
    this.sessionManager = new SessionManager(config.projectDir);
  }

  getSessionManager(): SessionManager | null {
    return this.sessionManager;
  }

  /** Get new context that `agent` hasn't seen yet from the message bus */
  private getNewContext(agent: AgentId): string {
    const sinceIndex = this.agentLastContextIndex.get(agent) ?? 0;
    const { summary, newIndex } = this.bus.getContextSummary(agent, sinceIndex);
    this.agentLastContextIndex.set(agent, newIndex);
    return summary;
  }

  bind(cb: OrchestratorCallbacks) {
    this.callbacks = cb;

    // Opus output & status — show delegation messages, buffer reports until all delegates finish
    this.opus.onOutput((line) => {
      flog.debug('AGENT', 'Output', { agent: 'opus', type: line.type, text: line.text.slice(0, 150) });
      this.detectRelayPatterns('opus', line.text);

      // When Opus has active delegates, buffer ALL stdout (not just long messages).
      // This prevents Opus from writing partial reports visible to the user before
      // all delegates have finished. The buffer is flushed when all delegates report.
      // EXCEPTION: in @tous mode (opusAllMode), Opus output passes through so the
      // user sees Opus working in real-time alongside Sonnet and Codex.
      if (this.expectedDelegates.size > 0 && line.type === 'stdout' && !this.opusAllMode) {
        // Always pass task tags through to the callback so the todo list updates in real-time
        const hasTaskTags = /\[TASK:(add|done)\]/i.test(line.text);
        if (hasTaskTags) {
          cb.onAgentOutput('opus', line);
        }
        // Allow only lines that are purely delegation tags or task tags to pass through
        const stripped = line.text
          .replace(/\[TO:(CLAUDE|CODEX|OPUS)\][^\n]*/gi, '')
          .replace(/\[FROM:(CLAUDE|CODEX|OPUS)\][^\n]*/gi, '')
          .replace(/\[TASK:(add|done)\][^\n]*/gi, '')
          .trim();
        if (stripped.length > 0) {
          flog.debug('BUFFER', `Opus stdout BUFFERED (${this.expectedDelegates.size} delegates pending): ${stripped.slice(0, 80)}`, { agent: 'opus' });
          this.relayBuffer.get('opus')!.push(line);
          return;
        }
        // If line was purely tags and already passed through via hasTaskTags, don't emit again
        if (hasTaskTags) return;
      }
      cb.onAgentOutput('opus', line);
    });
    this.opus.onStatusChange((s) => {
      flog.info('AGENT', `opus: ${s}`, { agent: 'opus' });
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        this.flushRelayDraft('opus');
      }
      cb.onAgentStatus('opus', s);
      if (s === 'running') {
        this.opusRestartCount = 0;
      }
      // Only auto-restart on genuine errors — NOT on clean stops (user Esc, shutdown, etc.)
      // A clean stop happens when stop() is called explicitly (this.started becomes false
      // during shutdown, or opusRestartPending is set to prevent re-entry).
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
        this.opusRestartTimer = setTimeout(async () => {
          this.opusRestartTimer = null;
          this.opusRestartPending = false;
          // Double-check: don't restart if orchestrator was stopped during the delay
          if (!this.started) {
            flog.info('ORCH', 'Opus restart skipped: orchestrator stopped during delay');
            return;
          }
          const config = this.config;
          if (!config) {
            flog.warn('ORCH', 'Opus restart skipped: config missing');
            return;
          }
          this.opusRestartCount++;
          flog.warn('ORCH', 'Opus crashed — auto-restarting...');
          cb.onAgentOutput('opus', {
            text: 'Opus redémarrage en cours...',
            timestamp: Date.now(),
            type: 'info',
          });
          try {
            await this.opus.start(
              { ...config, task: '' },
              getOpusSystemPrompt(config.projectDir),
            );
          } catch (e) {
            flog.error('ORCH', `Opus restart failed: ${e}`);
          }
        }, 2_000);
      }
    });

    // Bind worker agents (Claude, Codex) — shared output/status handlers
    this.bindWorkerAgent('claude', this.claude, cb);
    this.bindWorkerAgent('codex', this.codex, cb);

    this.bus.on('relay', (msg: Message) => {
      flog.info('RELAY', `${msg.from}->${msg.to}`, { from: msg.from, to: msg.to, preview: msg.content.slice(0, 100) });
      cb.onRelay(msg);
    });
    this.bus.on('relay-blocked', (msg: Message) => {
      flog.warn('RELAY', `Blocked: ${msg.from}->${msg.to}`, { from: msg.from, to: msg.to });
      cb.onRelayBlocked(msg);
    });

    // Route messages to Opus — inject cross-agent context
    this.bus.on('message:opus', (msg: Message) => {
      flog.debug('BUS', `${msg.from}->${msg.to}`, { preview: msg.content.slice(0, 100) });
      if (msg.from === 'opus') return;
      this.opusQueue.add(() => {
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        const context = this.getNewContext('opus');
        let payload = `${prefix} ${msg.content}`;
        if (context) {
          payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
        }
        this.opus.send(payload);
        return Promise.resolve();
      });
    });

    // Route messages to workers (lazy start) — inject cross-agent context
    this.bindWorkerRoute(
      'claude',
      this.claudeQueue,
      () => this.ensureWorkerStarted('claude'),
      () => this.workerReady.get('claude') ?? Promise.resolve(),
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
  ) {
    this.bus.on(`message:${agentId}`, (msg: Message) => {
      flog.debug('BUS', `${msg.from}->${msg.to}`, { preview: msg.content.slice(0, 100) });
      if (msg.from === agentId) return;
      if (msg.from !== 'opus' && msg.from !== 'user' && this.awaitingCrossTalkReply.has(agentId)) {
        flog.info('ORCH', `${agentId} received cross-talk reply from ${msg.from} — no longer awaiting`);
        this.awaitingCrossTalkReply.delete(agentId);
      }
      queue.add(async () => {
        await ensureStarted();
        void readyPromise();
        // Refresh cross-talk mute right before send — prevents stale status
        // transitions from clearing the mute during the async queue wait.
        if (this.agentsOnCrossTalk.has(agentId)) {
          this.agentsOnCrossTalk.set(agentId, Date.now());
        }
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        const context = this.getNewContext(agentId);
        let payload = `${prefix} ${msg.content}`;
        if (context) {
          payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
        }
        this.getAgent(agentId).send(payload);
      });
    });
  }

  /** Bind output and status handlers for a worker agent.
   *  Claude uses immediate auto-relay (stream-based); Codex uses timer-based safety-net. */
  private bindWorkerAgent(agentId: AgentId, agent: AgentProcess, cb: OrchestratorCallbacks) {
    const label = agentId.charAt(0).toUpperCase() + agentId.slice(1);
    // true for spawn-per-exec agents — they fire 'waiting' after EACH exec
    const usesTimerSafetyNet = agentId === 'codex';
    // For spawn-per-exec agents, cross-talk mute needs longer threshold before clearing
    const crossTalkClearThreshold = usesTimerSafetyNet ? 2_000 : 3_000;

    agent.onOutput((line) => {
      flog.debug('AGENT', 'Output', { agent: agentId, type: line.type, text: line.text.slice(0, 150) });
      // Keep heartbeat alive — agent is producing output
      this.recordDelegateActivity(agentId);
      // Agent's report already delivered to Opus — mute ALL late output completely
      if (this.deliveredToOpus.has(agentId) && line.type === 'stdout') {
        flog.debug('ORCH', `${label} output MUTED (delivered to Opus): ${line.text.slice(0, 80)}`);
        return;
      }
      // Agent already reported to Opus (pending combined delivery) — mute late stdout
      if (this.pendingReportsForOpus.has(agentId) && line.type === 'stdout') {
        flog.debug('ORCH', `${label} output MUTED (already reported to Opus): ${line.text.slice(0, 80)}`);
        this.detectRelayPatterns(agentId, line.text);
        return;
      }
      // Cross-talk mute — agent is responding to a peer message, suppress stdout
      if (this.agentsOnCrossTalk.has(agentId)) {
        const muteTime = this.agentsOnCrossTalk.get(agentId)!;
        if (Date.now() - muteTime > 15_000) {
          flog.warn('ORCH', `${label} cross-talk mute timeout (15s) — unmuting`);
          this.agentsOnCrossTalk.delete(agentId);
        } else {
          this.detectRelayPatterns(agentId, line.text);
          if (this.agentsOnRelay.has(agentId) && line.type === 'stdout') {
            flog.debug('BUFFER', 'On cross-talk + relay for opus', { agent: agentId });
            // Pass task tags through so todo list updates in real-time
            if (/\[TASK:(add|done)\]/i.test(line.text)) cb.onAgentOutput(agentId, line);
            this.relayBuffer.get(agentId)!.push(line);
          }
          if (line.type !== 'stdout') cb.onAgentOutput(agentId, line);
          return;
        }
      }
      if (this.agentsOnRelay.has(agentId)) {
        const start = this.relayStartTime.get(agentId) ?? 0;
        // RELAY_TIMEOUT_MS <= 0 means no relay timeout — wait indefinitely
        if (this.RELAY_TIMEOUT_MS > 0 && Date.now() - start > this.RELAY_TIMEOUT_MS) {
          this.agentsOnRelay.delete(agentId);
          this.relayBuffer.set(agentId, []);
          this.relayStartTime.delete(agentId);
          flog.warn('ORCH', `${label} relay timeout (${this.RELAY_TIMEOUT_MS / 1000}s) — unmuting`);
        } else {
          this.detectRelayPatterns(agentId, line.text);
          if (line.type === 'stdout') {
            flog.debug('BUFFER', 'On relay for opus', { agent: agentId });
            // Pass task tags through so todo list updates in real-time
            if (/\[TASK:(add|done)\]/i.test(line.text)) cb.onAgentOutput(agentId, line);
            this.relayBuffer.get(agentId)!.push(line);
          } else {
            cb.onAgentOutput(agentId, line);
          }
          return;
        }
      }
      const hasRelay = this.detectRelayPatterns(agentId, line.text);
      if (!hasRelay) cb.onAgentOutput(agentId, line);
    });

    agent.onStatusChange((s) => {
      flog.info('AGENT', `${agentId}: ${s}`, { agent: agentId });
      // Keep heartbeat alive — agent status changed
      this.recordDelegateActivity(agentId);
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        this.flushRelayDraft(agentId);
      }
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        const muteTime = this.agentsOnCrossTalk.get(agentId);
        if (muteTime !== undefined) {
          const elapsed = Date.now() - muteTime;
          if (elapsed > crossTalkClearThreshold || s === 'stopped' || s === 'error') {
            flog.info('ORCH', `Cross-talk MUTE CLEARED for ${agentId} (status=${s}, elapsed=${elapsed}ms)`);
            this.agentsOnCrossTalk.delete(agentId);
            if (this.pendingReportsForOpus.size >= this.expectedDelegates.size && this.expectedDelegates.size > 0) {
              this.deliverCombinedReportsToOpus();
            }
          } else if (usesTimerSafetyNet) {
            flog.info('ORCH', `Cross-talk mute kept for ${agentId} (status=${s}, elapsed=${elapsed}ms — too soon, likely stale exec)`);
          }
        }
      }
      if (s === 'stopped' || s === 'error') {
        flog.info('RELAY', `${agentId}: end`, { agent: agentId, detail: `status=${s}` });
        this.agentsOnRelay.delete(agentId);
        this.relayBuffer.set(agentId, []);
        this.relayStartTime.delete(agentId);
        if (this.expectedDelegates.has(agentId) && !this.pendingReportsForOpus.has(agentId)) {
          // ── Try fallback BEFORE using a placeholder ──
          // If this agent crashed/stopped without reporting, attempt to redelegate
          // to the other worker (or Opus as last resort) instead of immediately
          // inserting a placeholder and delivering a partial combined report.
          const originalTask = this.lastDelegationContent.get(agentId);
          const fallback = this.pickFallbackAgent(agentId);

          if (fallback && fallback !== 'opus' && originalTask) {
            flog.info('ORCH', `Agent ${agentId} ${s} — fallback to ${fallback}`);
            this.expectedDelegates.add(fallback);
            this.deliveredToOpus.delete(fallback);
            this.agentsOnRelay.add(fallback);
            this.relayStartTime.set(fallback, Date.now());
            this.lastDelegationContent.set(fallback, originalTask);
            this.delegateLastActivity.set(fallback, Date.now());
            this.recordRelay();
            this.bus.relay('opus', fallback, `[FALLBACK — ${agentId} ${s}] ${originalTask}`);
            if (this.callbacks) {
              this.callbacks.onAgentOutput(agentId, {
                text: `${agentId} ${s} — tache transferee a ${fallback}`,
                timestamp: Date.now(),
                type: 'info',
              });
            }
          } else if (fallback === 'opus' && originalTask) {
            // Both workers unavailable — Opus takes over
            flog.info('ORCH', `Agent ${agentId} ${s}, no worker fallback — Opus takes over`);
            this.expectedDelegates.clear();
            this.pendingReportsForOpus.clear();
            this.stopDelegateHeartbeat();
            this.bus.send({
              from: 'system',
              to: 'opus',
              content: `[FALLBACK — ${agentId} ${s}, aucun agent disponible] Fais le travail toi-meme: ${originalTask}`,
            });
            if (this.callbacks) {
              this.callbacks.onAgentOutput(agentId, {
                text: `${agentId} ${s} — Opus prend le relais`,
                timestamp: Date.now(),
                type: 'info',
              });
            }
          } else {
            // No fallback possible — use placeholder
            this.pendingReportsForOpus.set(agentId, `(agent ${s} — pas de rapport)`);
            if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
              this.deliverCombinedReportsToOpus();
            }
          }
        }
        // Only flush Opus buffer if NO delegates are still pending —
        // prevents Opus from writing partial output before all reports arrive
        if (!this.isOpusWaitingForRelays() && this.expectedDelegates.size === 0 && this.callbacks) {
          this.flushOpusBuffer(this.callbacks);
        }
      }
      // Safety net: auto-relay buffer when agent finishes relay without [TO:OPUS]
      if (s === 'waiting' && this.agentsOnRelay.has(agentId) && !this.awaitingCrossTalkReply.has(agentId)) {
        if (usesTimerSafetyNet) {
          // Spawn-per-exec: use timer with grace period (agent may fire 'waiting' multiple times)
          const prevTimer = this.safetyNetTimers.get(agentId);
          if (prevTimer) clearTimeout(prevTimer);
          const timer = setTimeout(() => {
            this.safetyNetTimers.delete(agentId);
            if (!this.agentsOnRelay.has(agentId) || this.pendingReportsForOpus.has(agentId)) return;
            this.autoRelayBuffer(agentId);
          }, this.SAFETY_NET_GRACE_MS);
          this.safetyNetTimers.set(agentId, timer);
        } else {
          // Stream-based (Claude): immediate auto-relay is safe
          this.autoRelayBuffer(agentId);
        }
      }
      cb.onAgentStatus(agentId, s);
    });
  }

  private async ensureWorkerStarted(agentId: WorkerAgentId) {
    if (!this.config) return;

    const existing = this.workerReady.get(agentId) ?? Promise.resolve();
    if (this.workerStarted.get(agentId)) {
      await existing;
      return;
    }

    this.workerStarted.set(agentId, true);
    const config = this.config;

    let prompt = '';
    let agent: AgentProcess;
    if (agentId === 'claude') {
      flog.info('ORCH', 'Lazy-starting Claude...');
      prompt = getClaudeSystemPrompt(config.projectDir);
      agent = this.claude;
    } else if (agentId === 'codex') {
      flog.info('ORCH', 'Lazy-starting Codex...');
      prompt = getCodexSystemPrompt(config.projectDir);
      this.codex.setContextReminder?.(getCodexContextReminder(config.projectDir));
      agent = this.codex;
    } else {
      flog.warn('ORCH', `Unknown worker agent: ${agentId}`);
      return;
    }

    const { summary, newIndex } = this.bus.getContextSummary(agentId, 0, 5);
    this.agentLastContextIndex.set(agentId, newIndex);
    if (summary) {
      prompt += `\n\n--- HISTORIQUE ---\n${summary}\n--- FIN ---`;
    }

    const ready = agent.start({ ...config, task: '' }, prompt);
    this.workerReady.set(agentId, ready);
    await ready;
  }

  /** Start with first user message. Only Opus starts immediately. */
  async startWithTask(task: string, previousContext?: string) {
    if (this.started || !this.config) return;

    const config = this.config;
    flog.info('ORCH', `Starting Opus with task: ${task.slice(0, 80)}`);

    // Create persistent session
    await this.sessionManager?.createSession(task, config.projectDir);

    // Listen for all bus messages → persist them (cleanup old handler first)
    if (this.sessionMessageHandler) {
      this.bus.off('message', this.sessionMessageHandler);
    }
    this.sessionMessageHandler = (msg: Message) => this.sessionManager?.addMessage(msg);
    this.bus.on('message', this.sessionMessageHandler);

    // Build Opus prompt — include previous context if restarting
    let opusPrompt = getOpusSystemPrompt(config.projectDir);
    if (previousContext) {
      opusPrompt += `\n\n--- HISTORIQUE SESSION PRECEDENTE ---\n${previousContext}\n--- FIN HISTORIQUE ---`;
    }
    opusPrompt += `\n\nMESSAGE DU USER: ${task}`;

    // Only Opus starts immediately — Claude starts lazily when Opus delegates
    // If Opus has a sessionId from the previous run, --resume will be used
    // and the initial message will be skipped (session already has context)
    await this.opus.start({ ...config, task }, opusPrompt);
    this.started = true; // Set AFTER start succeeds — allows retry on failure

    // If Opus resumed its session, send the new task as a follow-up message
    // (the resumed session already has the system prompt + previous conversation)
    if (this.opus.getSessionId()) {
      const resumeMsg = previousContext
        ? `[NOUVELLE TACHE DU USER] ${task}\n\nContexte: la session precedente a ete interrompue puis reprise. Tu as tout l'historique dans ta conversation. Continue ton travail.`
        : `[NOUVELLE TACHE DU USER] ${task}`;
      this.opus.send(resumeMsg);
      flog.info('ORCH', 'Opus resumed session — sent new task as follow-up');
    }

    flog.info('ORCH', 'Opus started (Sonnet, Codex on standby — lazy start)');
  }

  get isStarted() {
    return this.started;
  }

  /** True when Opus has delegated to agents and is still waiting for their reports.
   *  Used by the UI to keep the spinner active even when no agent is 'running'. */
  get hasPendingDelegates(): boolean {
    return this.expectedDelegates.size > 0;
  }

  /** Restart after stop — preserve agent sessions and conversation context */
  async restart(task: string) {
    // Build conversation summary BEFORE resetting bus history
    const previousContext = this.buildConversationSummary();

    // Finalize previous session before creating a new one
    await this.sessionManager?.finalize();

    // Reset internal orchestration state (but NOT agent sessionIds — they're preserved)
    this.resetState();

    // Cleanup session message listener before re-registering in startWithTask
    if (this.sessionMessageHandler) {
      this.bus.off('message', this.sessionMessageHandler);
      this.sessionMessageHandler = null;
    }

    // Reset bus history
    this.bus.reset();

    flog.info('ORCH', `Restarting with context (${previousContext ? previousContext.length : 0} chars)`);

    // Start with preserved context — agents will resume their CLI sessions
    await this.startWithTask(task, previousContext || undefined);
  }

  /** Build a compact summary of the conversation from bus history.
   *  Used to inject context into Opus when restarting after Esc. */
  private buildConversationSummary(): string | null {
    const history = this.bus.getHistory();
    if (history.length === 0) return null;

    // Take last 30 messages max to stay within reasonable token limits
    const recent = history.slice(-30);
    const lines: string[] = [];

    for (const msg of recent) {
      const content = msg.content.length > 300
        ? msg.content.slice(0, 300) + '...'
        : msg.content;
      lines.push(`[${msg.from.toUpperCase()} -> ${msg.to.toUpperCase()}] ${content}`);
    }

    return lines.join('\n');
  }

  sendUserMessage(text: string) {
    // Normal user message to Opus — exit @tous mode
    this.opusAllMode = false;
    // If Opus is actively running, inject LIVE instead of queuing behind PQueue
    if (this.opus.status === 'running') {
      this.sendUserMessageLive(text, 'opus');
    } else {
      this.bus.send({ from: 'user', to: 'opus', content: text });
    }
  }

  /** Send a LIVE message to an agent — bypasses PQueue if agent is running */
  sendUserMessageLive(text: string, target: AgentId) {
    const agent = this.getAgent(target);
    if (agent.status === 'running') {
      agent.sendUrgent(`[LIVE MESSAGE DU USER] ${text}`);
      // Record in bus history so context tracking stays accurate
      this.bus.record({ from: 'user', to: target, content: text });
    } else {
      this.bus.send({ from: 'user', to: target, content: text });
    }
  }

  sendToAgent(agent: AgentId, text: string) {
    // User speaking directly to agent — clear relay mute and flush buffer
    this.agentsOnRelay.delete(agent);
    this.agentsOnCrossTalk.delete(agent);
    this.awaitingCrossTalkReply.delete(agent);
    this.expectedDelegates.delete(agent);
    this.pendingReportsForOpus.delete(agent);
    this.deliveredToOpus.delete(agent);
    // Cancel safety-net timer
    const timer = this.safetyNetTimers.get(agent);
    if (timer) { clearTimeout(timer); this.safetyNetTimers.delete(agent); }
    if (this.callbacks) {
      for (const buffered of this.relayBuffer.get(agent) ?? []) {
        this.callbacks.onAgentOutput(agent, buffered);
      }
    }
    this.relayBuffer.set(agent, []);
    // If agent is running, inject LIVE instead of queuing
    const agentInstance = this.getAgent(agent);
    if (agentInstance.status === 'running') {
      agentInstance.sendUrgent(`[FROM:USER] ${text}`);
      this.bus.record({ from: 'user', to: agent, content: text });
    } else {
      this.bus.send({ from: 'user', to: agent, content: text });
    }
  }

  /** Send message directly from user to all agents — agents respond directly, no relay buffering */
  sendToAllDirect(text: string) {
    // Clear all relay state so agents respond directly (not buffered for Opus)
    this.agentsOnRelay.clear();
    this.agentsOnCrossTalk.clear();
    this.awaitingCrossTalkReply.clear();
    this.relayStartTime.clear();
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.deliveredToOpus.clear();
    this.relayDrafts.clear();
    this.crossTalkCount = 0;
    // Cancel all safety-net timers
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();

    for (const agent of ['claude', 'codex', 'opus'] as AgentId[]) {
      if (this.callbacks) {
        for (const buffered of this.relayBuffer.get(agent) ?? []) {
          this.callbacks.onAgentOutput(agent, buffered);
        }
      }
      this.relayBuffer.set(agent, []);
    }
    const opusAllModeMessage = buildOpusAllModeUserMessage(text);
    // Enable @tous mode — Opus stdout passes through (user sees Opus working)
    this.opusAllMode = true;

    // Send LIVE to running agents, normal bus.send to idle ones
    for (const agentId of ['opus', 'claude', 'codex'] as AgentId[]) {
      const payload = agentId === 'opus' ? opusAllModeMessage : text;
      const agent = this.getAgent(agentId);
      if (agent.status === 'running') {
        agent.sendUrgent(`[FROM:USER] ${payload}`);
        // Record in bus history
        this.bus.record({ from: 'user', to: agentId, content: payload });
      } else {
        this.bus.send({ from: 'user', to: agentId, content: payload });
      }
    }
  }

  private resetState() {
    this.started = false;
    if (this.opusRestartTimer) {
      clearTimeout(this.opusRestartTimer);
      this.opusRestartTimer = null;
    }
    this.opusRestartPending = false;
    this.opusRestartCount = 0;
    this.workerStarted = new Map([
      ['claude', false],
      ['codex', false],
    ]);
    this.workerReady = new Map([
      ['claude', Promise.resolve()],
      ['codex', Promise.resolve()],
    ]);
    this.agentLastContextIndex = new Map([
      ['opus', 0],
      ['claude', 0],
      ['codex', 0],
    ]);
    this.agentsOnRelay.clear();
    this.agentsOnCrossTalk.clear();
    this.awaitingCrossTalkReply.clear();
    this.relayBuffer = new Map([
      ['claude', []],
      ['codex', []],
      ['opus', []],
    ]);
    this.relayStartTime.clear();
    this.relayTimestamps = [];
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.deliveredToOpus.clear();
    this.crossTalkCount = 0;
    this.opusAllMode = false;
    this.lastDelegationContent.clear();
    this.relayDrafts.clear();
    for (const timer of this.relayDraftTimers.values()) clearTimeout(timer);
    this.relayDraftTimers.clear();
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();
    this.stopDelegateHeartbeat();
  }

  private isRelayRateLimited(now = Date.now()): boolean {
    while (this.relayTimestamps.length > 0 && now - this.relayTimestamps[0] >= RELAY_WINDOW_MS) {
      this.relayTimestamps.shift();
    }
    return this.relayTimestamps.length >= MAX_RELAYS_PER_WINDOW;
  }

  private recordRelay() {
    this.relayTimestamps.push(Date.now());
  }

  private isRelayTag(line: string): boolean {
    return (
      TO_CLAUDE_PATTERN.test(line) || TO_CODEX_PATTERN.test(line) || TO_OPUS_PATTERN.test(line)
    );
  }

  private matchRelayTag(
    line: string,
    from: AgentId,
  ): { target: AgentId; firstLine: string } | null {
    if (from !== 'claude') {
      const m = line.match(TO_CLAUDE_PATTERN);
      if (m) return { target: 'claude', firstLine: m[1].trim() };
    }
    if (from !== 'codex') {
      const m = line.match(TO_CODEX_PATTERN);
      if (m) return { target: 'codex', firstLine: m[1].trim() };
    }
    if (from !== 'opus') {
      const m = line.match(TO_OPUS_PATTERN);
      if (m) return { target: 'opus', firstLine: m[1].trim() };
    }
    return null;
  }

  /** Resolve an AgentId to the corresponding agent instance */
  private getAgent(id: AgentId) {
    return this.agents[id];
  }

  /** Route one parsed relay message to target with all guard rails applied. */
  private routeRelayMessage(from: AgentId, target: AgentId, rawContent: string) {
    const content = rawContent.trim();
    if (!content) return;

    flog.info('RELAY', `${from}->${target}: ${content.slice(0, 80)}`);

    // ── Cross-talk: peer-to-peer between agents (not via Opus) ──
    // Cross-talk is checked BEFORE rate-limit — it has its own limit (MAX_CROSS_TALK_PER_ROUND)
    const isPeerToPeer =
      from !== 'opus' && target !== 'opus' && from !== target;

    if (isPeerToPeer) {
      if (this.crossTalkCount >= this.MAX_CROSS_TALK_PER_ROUND) {
        flog.warn('ORCH', `Cross-talk limit reached (${this.crossTalkCount}/${this.MAX_CROSS_TALK_PER_ROUND}) — blocking ${from}->${target}`);
        // Don't relay — agents will continue their own work
      } else {
        this.crossTalkCount++;
        flog.info('ORCH', `Cross-talk ${this.crossTalkCount}/${this.MAX_CROSS_TALK_PER_ROUND}: ${from}->${target}`);
        // Mark initiator as waiting for reply — prevents safety-net auto-relay
        this.awaitingCrossTalkReply.add(from);
        // Mute the target agent's stdout — cross-talk response is internal
        this.agentsOnCrossTalk.set(target, Date.now());
        flog.info('ORCH', `Cross-talk MUTE SET for ${target}, ${from} awaiting reply`);
        // Cross-talk does NOT count against relay rate limit — only record, don't check limit
        this.bus.relay(from, target, content);
      }
      return;
    }

    // ── Rate-limit check (applies to standard relays only, NOT cross-talk) ──
    if (this.isRelayRateLimited()) {
      flog.warn('ORCH', `Relay rate limited — skipping from ${from}`);
      this.callbacks?.onAgentOutput(from, {
        text: '[Rate limit] Trop de relays — patientez quelques secondes.',
        timestamp: Date.now(),
        type: 'info',
      });
      return;
    }

    // ── Standard delegation / report flow ──
    if (from === 'opus' && target !== 'opus') {
      // New delegation — clear delivered tracking for this agent (fresh round)
      this.deliveredToOpus.delete(target);
      this.agentsOnRelay.add(target);
      this.relayStartTime.set(target, Date.now());
      this.expectedDelegates.add(target);
      // Store delegation content for auto-fallback if agent fails
      this.lastDelegationContent.set(target, content);
      flog.info('ORCH', `Expected delegates: ${[...this.expectedDelegates].join(', ')}`);
      // Start/reset independent delegate timeout — force-deliver if all delegates haven't reported
      this.resetDelegateTimeout();
    }

    this.recordRelay();

    // Agent reporting back to Opus — buffer the report instead of delivering immediately.
    // When ALL expected delegates have reported, deliver a combined message.
    if (target === 'opus' && from !== 'opus' && this.expectedDelegates.has(from)) {
      this.pendingReportsForOpus.set(from, content);
      // Agent has reported — remove from relay tracking so safety-net won't re-fire
      this.agentsOnRelay.delete(from);
      this.relayBuffer.set(from, []);
      this.relayStartTime.delete(from);
      this.awaitingCrossTalkReply.delete(from);
      // Cancel any pending safety-net timer (agent reported explicitly)
      const pendingTimer = this.safetyNetTimers.get(from);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.safetyNetTimers.delete(from);
      }
      // Delegate reported to Opus — clear cross-talk mute if active (work is done)
      if (this.agentsOnCrossTalk.has(from)) {
        flog.info('ORCH', `Clearing cross-talk mute for ${from} (reported to Opus)`);
        this.agentsOnCrossTalk.delete(from);
      }
      flog.info('ORCH', `Buffered report from ${from} (${this.pendingReportsForOpus.size}/${this.expectedDelegates.size} received)`);
      // Check if all delegates have reported
      if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
        this.deliverCombinedReportsToOpus();
      }
      return;
    }

    this.bus.relay(from, target, content);
    // Keep muted until the agent finishes — safety-net on 'waiting' will auto-relay
    if (target === 'opus' && from !== 'opus') {
      this.relayBuffer.set(from, []);
    }
  }

  /** Flush pending [TO:*] relay draft for one agent, if any.
   *  @param force  When true, flush even if content is empty (used when
   *                a NEW tag from the same sender force-closes the previous draft,
   *                or on agent status change). When false (timer-based), an empty
   *                draft gets re-scheduled up to RELAY_DRAFT_MAX_EMPTY_RETRIES times
   *                so that late-arriving content isn't lost. */
  private flushRelayDraft(from: AgentId, force = true): boolean {
    const timer = this.relayDraftTimers.get(from);
    if (timer) {
      clearTimeout(timer);
      this.relayDraftTimers.delete(from);
    }

    const draft = this.relayDrafts.get(from);
    if (!draft) return false;

    const content = draft.parts.join('\n').trim();

    if (!content) {
      if (!force) {
        // Timer-based flush with empty content — more data may still be arriving.
        // Re-schedule instead of dropping, up to a maximum retry count.
        const retries = this.relayDraftEmptyRetries.get(from) ?? 0;
        if (retries < this.RELAY_DRAFT_MAX_EMPTY_RETRIES) {
          this.relayDraftEmptyRetries.set(from, retries + 1);
          flog.debug('RELAY', `Draft for ${from}->${draft.target} still empty, retry ${retries + 1}/${this.RELAY_DRAFT_MAX_EMPTY_RETRIES}`);
          this.scheduleRelayDraftFlush(from);
          return false;
        }
        flog.debug('RELAY', `Draft for ${from}->${draft.target} empty after max retries, dropping`);
      }
      // Force flush or max retries reached — discard the empty draft.
      this.relayDrafts.delete(from);
      this.relayDraftEmptyRetries.delete(from);
      return false;
    }

    this.relayDrafts.delete(from);
    this.relayDraftEmptyRetries.delete(from);
    this.routeRelayMessage(from, draft.target, content);
    return true;
  }

  /** Schedule a short debounce flush for a relay draft to catch cross-chunk payloads. */
  private scheduleRelayDraftFlush(from: AgentId) {
    const prev = this.relayDraftTimers.get(from);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.relayDraftTimers.delete(from);
      this.flushRelayDraft(from, false /* timer-based, not forced */);
    }, this.RELAY_DRAFT_FLUSH_MS);
    this.relayDraftTimers.set(from, timer);
  }

  /** Detect [TO:*] relay tags in streamed output with stateful parsing across chunks. */
  private detectRelayPatterns(from: AgentId, text: string): boolean {
    // Pre-process: split lines that contain multiple [TO:*] tags on the same line
    // e.g. "[TO:CLAUDE] [TO:CODEX] Hello" → "[TO:CLAUDE]" and "[TO:CODEX] Hello"
    const rawLines = text.split('\n');
    const lines: string[] = [];
    const multiTagRe = /(\[TO:(?:CLAUDE|CODEX|OPUS)\])/g;
    for (const raw of rawLines) {
      const tags: { idx: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = multiTagRe.exec(raw)) !== null) {
        tags.push({ idx: m.index });
      }
      if (tags.length <= 1) {
        lines.push(raw);
      } else {
        // Split at each tag boundary
        for (let t = 0; t < tags.length; t++) {
          const start = tags[t].idx;
          const end = t + 1 < tags.length ? tags[t + 1].idx : raw.length;
          lines.push(raw.slice(start, end).trimEnd());
        }
      }
    }

    let foundRelayTag = false;
    for (const line of lines) {
      const match = this.matchRelayTag(line, from);
      if (match) {
        foundRelayTag = true;
        // A new tag closes the previous draft from the same sender.
        this.flushRelayDraft(from);
        const draft = {
          target: match.target,
          parts: [] as string[],
        };
        if (match.firstLine) {
          draft.parts.push(match.firstLine);
        }
        this.relayDrafts.set(from, draft);
        this.scheduleRelayDraftFlush(from);
        continue;
      }

      // No new tag on this line: append to current draft, if one is open.
      const draft = this.relayDrafts.get(from);
      if (draft) {
        draft.parts.push(line);
        this.scheduleRelayDraftFlush(from);
      }
    }

    return foundRelayTag;
  }

  /** Record delegate activity — called on output or status change to keep heartbeat alive */
  private recordDelegateActivity(agent: AgentId) {
    if (this.expectedDelegates.has(agent)) {
      this.delegateLastActivity.set(agent, Date.now());
    }
  }

  /** Start/reset the heartbeat that monitors delegates.
   *  Instead of a fixed timeout, we periodically check if agents are still active.
   *  An agent is only considered "timed out" if it is NOT running AND has been
   *  idle (no output/activity) for DELEGATE_IDLE_TIMEOUT_MS. */
  private resetDelegateTimeout() {
    // Initialize activity timestamp for new delegates
    const now = Date.now();
    for (const delegate of this.expectedDelegates) {
      if (!this.delegateLastActivity.has(delegate)) {
        this.delegateLastActivity.set(delegate, now);
      }
    }

    // Don't create duplicate heartbeats — one is enough
    if (this.delegateHeartbeatTimer) return;

    this.delegateHeartbeatTimer = setInterval(() => {
      if (this.expectedDelegates.size === 0) {
        this.stopDelegateHeartbeat();
        return;
      }

      const now = Date.now();
      const timedOut: AgentId[] = [];

      for (const delegate of this.expectedDelegates) {
        if (this.pendingReportsForOpus.has(delegate)) continue; // already reported

        const agent = this.getAgent(delegate);
        const lastActivity = this.delegateLastActivity.get(delegate) ?? now;
        const idleMs = now - lastActivity;

        // Agent is still running — it's working, NOT timed out. Reset activity.
        if (agent.status === 'running') {
          this.delegateLastActivity.set(delegate, now);
          flog.debug('ORCH', `Heartbeat: ${delegate} still running (active)`);
          continue;
        }

        // Agent is not running AND has been idle too long — truly stuck
        // DELEGATE_IDLE_TIMEOUT_MS <= 0 means no timeout — never consider agents stuck
        if (this.DELEGATE_IDLE_TIMEOUT_MS > 0 && idleMs >= this.DELEGATE_IDLE_TIMEOUT_MS) {
          flog.warn('ORCH', `Heartbeat: ${delegate} idle for ${Math.round(idleMs / 1000)}s (status=${agent.status}) — timing out`);
          timedOut.push(delegate);
        } else {
          flog.debug('ORCH', `Heartbeat: ${delegate} idle ${Math.round(idleMs / 1000)}s/${Math.round(this.DELEGATE_IDLE_TIMEOUT_MS / 1000)}s (status=${agent.status})`);
        }
      }

      if (timedOut.length === 0) return;

      // Handle timed-out delegates — fallback logic
      for (const delegate of timedOut) {
        const fallback = this.pickFallbackAgent(delegate);
        const originalTask = this.lastDelegationContent.get(delegate);

        if (fallback === 'opus' && originalTask) {
          flog.info('ORCH', `Heartbeat timeout: both workers unavailable — Opus takes over: ${originalTask.slice(0, 80)}`);
          this.expectedDelegates.clear();
          this.pendingReportsForOpus.clear();
          this.stopDelegateHeartbeat();
          this.bus.send({
            from: 'system',
            to: 'opus',
            content: `[FALLBACK — ${delegate} timeout, aucun agent disponible] Fais le travail toi-meme: ${originalTask}`,
          });
          if (this.callbacks) {
            this.callbacks.onAgentOutput(delegate, {
              text: `${delegate} timeout — Opus prend le relais`,
              timestamp: Date.now(),
              type: 'info',
            });
          }
          return;
        }

        if (fallback && fallback !== 'opus' && originalTask) {
          flog.info('ORCH', `Heartbeat fallback: ${delegate} → ${fallback}`);
          this.expectedDelegates.add(fallback);
          this.deliveredToOpus.delete(fallback);
          this.agentsOnRelay.add(fallback);
          this.relayStartTime.set(fallback, Date.now());
          this.lastDelegationContent.set(fallback, originalTask);
          this.delegateLastActivity.set(fallback, Date.now());
          this.recordRelay();
          this.bus.relay('opus', fallback, `[FALLBACK — ${delegate} timeout] ${originalTask}`);

          if (this.callbacks) {
            this.callbacks.onAgentOutput(delegate, {
              text: `${delegate} timeout — tache redirigee vers ${fallback}`,
              timestamp: Date.now(),
              type: 'info',
            });
          }
          return;
        }

        flog.warn('ORCH', `${delegate} timeout — no fallback available, using placeholder`);
        this.pendingReportsForOpus.set(delegate, '(timeout — pas de rapport)');

        if (this.callbacks) {
          this.callbacks.onAgentOutput(delegate, {
            text: `${delegate} timeout — pas de reponse (aucun agent de secours disponible)`,
            timestamp: Date.now(),
            type: 'info',
          });
        }
      }

      if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
        this.stopDelegateHeartbeat();
        this.deliverCombinedReportsToOpus();
      }
    }, this.DELEGATE_HEARTBEAT_INTERVAL_MS);
  }

  /** Stop the delegate heartbeat interval */
  private stopDelegateHeartbeat() {
    if (this.delegateHeartbeatTimer) {
      clearInterval(this.delegateHeartbeatTimer);
      this.delegateHeartbeatTimer = null;
    }
    this.delegateLastActivity.clear();
  }

  /** Check if Opus is waiting for delegate reports */
  private isOpusWaitingForRelays(): boolean {
    for (const agent of this.agentsOnRelay) {
      if (agent !== 'opus') return true;
    }
    return false;
  }

  /** Discard Opus buffered partial reports — Opus will write a fresh synthesis */
  private flushOpusBuffer(_cb: OrchestratorCallbacks) {
    const buffer = this.relayBuffer.get('opus') ?? [];
    if (buffer.length > 0) {
      flog.info('ORCH', `Discarding ${buffer.length} buffered partial report lines (delegates done — Opus will write fresh synthesis)`);
    }
    this.relayBuffer.set('opus', []);
  }

  /** Check if any delegate has an active cross-talk that hasn't resolved yet.
   *  This prevents premature combined delivery when delegates are still exchanging messages. */
  private hasDelegateCrossTalkPending(): boolean {
    for (const delegate of this.expectedDelegates) {
      if (this.agentsOnCrossTalk.has(delegate)) {
        flog.debug('ORCH', `Cross-talk still active for delegate ${delegate} — holding combined delivery`);
        return true;
      }
    }
    return false;
  }

  /** Extract buffered text for an agent and handle auto-relay or combined delivery */
  private autoRelayBuffer(agent: AgentId) {
    const buffer = this.relayBuffer.get(agent) ?? [];
    const textLines = buffer
      .filter((l) => l.type === 'stdout')
      .map((l) => l.text)
      .filter((t) => !this.isRelayTag(t))
      .join('\n')
      .trim();
    if (textLines) {
      flog.info('ORCH', `${agent} finished on relay without [TO:OPUS] — auto-relaying ${textLines.length} chars`);
      if (this.expectedDelegates.has(agent)) {
        this.pendingReportsForOpus.set(agent, textLines);
        flog.info('ORCH', `Auto-buffered ${agent} report (${this.pendingReportsForOpus.size}/${this.expectedDelegates.size})`);
        if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
          this.deliverCombinedReportsToOpus();
        }
      } else {
        this.recordRelay();
        this.bus.relay(agent, 'opus', textLines);
      }
    } else {
      // Check if the agent had an API error
      const agentInstance = this.getAgent(agent);
      const lastErr = agentInstance.lastError ?? null;
      const placeholder = lastErr
        ? `(erreur: ${lastErr})`
        : '(pas de rapport)';
      flog.warn('ORCH', `${agent} finished on relay — no buffered text to relay (${placeholder})`);

      // ── Orchestrator-level fallback: try to redelegate to another agent ──
      const hadExpected = this.expectedDelegates.has(agent);
      const fallback = this.pickFallbackAgent(agent);
      const originalTask = this.lastDelegationContent.get(agent);

      if (fallback === 'opus' && originalTask && hadExpected) {
        // Both workers failed/unavailable — Opus takes over and does the work itself
        flog.info('ORCH', `Both workers unavailable — signaling Opus to handle: ${originalTask.slice(0, 80)}`);
        this.expectedDelegates.clear();
        this.pendingReportsForOpus.clear();
        this.bus.send({
          from: 'system',
          to: 'opus',
          content: `[FALLBACK — ${agent} et l'autre agent ont echoue] Fais le travail toi-meme: ${originalTask}`,
        });
        if (this.callbacks) {
          this.callbacks.onAgentOutput(agent, {
            text: `${agent} indisponible — Opus prend le relais`,
            timestamp: Date.now(),
            type: 'info',
          });
        }
      } else if (fallback && fallback !== 'opus' && originalTask && hadExpected) {
        flog.info('ORCH', `Auto-fallback: ${agent} failed → redelegating to ${fallback}`);
        this.expectedDelegates.add(fallback);
        this.deliveredToOpus.delete(fallback);
        this.agentsOnRelay.add(fallback);
        this.relayStartTime.set(fallback, Date.now());
        this.recordRelay();
        this.bus.relay('opus', fallback, `[FALLBACK — ${agent} a echoue] ${originalTask}`);
        if (this.callbacks) {
          this.callbacks.onAgentOutput(agent, {
            text: `${agent} indisponible — tache transferee a ${fallback}`,
            timestamp: Date.now(),
            type: 'info',
          });
        }
      } else {
        if (hadExpected) {
          this.pendingReportsForOpus.set(agent, placeholder);
          if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
            this.deliverCombinedReportsToOpus();
          }
        }
      }
    }
    this.agentsOnRelay.delete(agent);
    this.relayBuffer.set(agent, []);
    this.relayStartTime.delete(agent);
    if (!this.isOpusWaitingForRelays() && this.expectedDelegates.size === 0 && this.callbacks) {
      this.flushOpusBuffer(this.callbacks);
    }
  }

  /** Pick a fallback agent when one fails.
   *  Returns 'opus' if no worker fallback is available — Opus takes over. */
  private pickFallbackAgent(failedAgent: AgentId): AgentId | null {
    // Sonnet failed → Codex can do both front and back
    // Codex failed → Sonnet can do both front and back
    const fallbackMap: Record<string, AgentId[]> = {
      claude: ['codex'],
      codex: ['claude'],
    };

    // Remove the failed agent from expectedDelegates so the fallback candidate
    // isn't blocked by the "already an expected delegate" check.
    this.expectedDelegates.delete(failedAgent);

    const candidates = fallbackMap[failedAgent] ?? [];
    for (const candidate of candidates) {
      // Don't pick an agent that's already an expected delegate for this round
      if (this.expectedDelegates.has(candidate)) continue;
      // Don't pick an agent that is in error/stopped state
      const agent = this.getAgent(candidate);
      if (agent.status === 'error' || agent.status === 'stopped') {
        flog.info('ORCH', `Fallback candidate ${candidate} skipped (status=${agent.status})`);
        continue;
      }
      return candidate;
    }

    // All worker candidates are unavailable — signal Opus to do the work itself
    flog.info('ORCH', `No worker fallback for ${failedAgent} — Opus will handle the task directly`);
    return 'opus';
  }

  /** Deliver all pending delegate reports as ONE combined message to Opus */
  private deliverCombinedReportsToOpus() {
    if (this.pendingReportsForOpus.size === 0) return;

    // Don't deliver if cross-talk is still in progress between delegates
    if (this.hasDelegateCrossTalkPending()) {
      flog.info('ORCH', `Combined delivery deferred — cross-talk still active (${this.pendingReportsForOpus.size}/${this.expectedDelegates.size} reports ready)`);
      return;
    }

    const parts: string[] = [];
    for (const [agent, report] of this.pendingReportsForOpus) {
      parts.push(`[FROM:${agent.toUpperCase()}] ${report}`);
    }
    const combined = parts.join('\n\n---\n\n');
    flog.info('ORCH', `Delivering combined report to Opus (${this.pendingReportsForOpus.size} delegates): ${combined.slice(0, 120)}`);

    // Track delivered agents — late output from these will be muted completely.
    // Also mute exec-based agents to stop wasting compute on their current task.
    for (const delegate of this.expectedDelegates) {
      this.deliveredToOpus.add(delegate);
      const agent = this.getAgent(delegate);
      if (agent.mute) {
        agent.mute();
        flog.info('ORCH', `Muted ${delegate} after combined delivery (save compute)`);
      }
    }

    // Clear ALL delegate tracking — relay, mute, cross-talk, safety-net timers
    for (const delegate of this.expectedDelegates) {
      this.agentsOnRelay.delete(delegate);
      this.agentsOnCrossTalk.delete(delegate);
      this.awaitingCrossTalkReply.delete(delegate);
      this.relayBuffer.set(delegate, []);
      this.relayStartTime.delete(delegate);
      // Cancel any pending safety-net timer
      const timer = this.safetyNetTimers.get(delegate);
      if (timer) {
        clearTimeout(timer);
        this.safetyNetTimers.delete(delegate);
      }
    }
    // Capture agents before clearing, for relay events below
    const deliveredAgents = [...this.pendingReportsForOpus.keys()];

    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.crossTalkCount = 0;
    // Clear @tous mode — Opus buffering returns to normal
    this.opusAllMode = false;
    // Clear delegate heartbeat — delivery complete
    this.stopDelegateHeartbeat();

    // Emit synthetic relay events for each agent so the UI shows "Agent → Opus"
    for (const agent of deliveredAgents) {
      this.bus.emit('relay', { from: agent, to: 'opus', content: '', id: '', timestamp: Date.now(), relayCount: 0 });
    }

    // Deliver as a single message via the bus
    this.recordRelay();
    this.bus.send({ from: 'system', to: 'opus', content: combined });

    // Flush Opus buffer so he writes a fresh synthesis
    if (this.callbacks) {
      this.flushOpusBuffer(this.callbacks);
    }
  }

  async stop() {
    flog.info('ORCH', 'Shutting down...');

    // 0. Mark as not started FIRST — prevents Opus status handler from
    //    scheduling a new restart timer when agents emit 'stopped' during shutdown
    this.started = false;

    // 1. Clear all queues FIRST — prevent new messages from being sent to agents
    this.opusQueue.clear();
    this.claudeQueue.clear();
    this.codexQueue.clear();

    // 2. Cancel all safety-net, delegate, and restart timers
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();
    this.stopDelegateHeartbeat();
    if (this.opusRestartTimer) {
      clearTimeout(this.opusRestartTimer);
      this.opusRestartTimer = null;
      this.opusRestartPending = false;
    }

    // 3. Clear all relay/mute state so no stale handlers fire
    this.agentsOnRelay.clear();
    this.agentsOnCrossTalk.clear();
    this.awaitingCrossTalkReply.clear();
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.deliveredToOpus.clear();
    this.opusAllMode = false;
    this.relayDrafts.clear();
    for (const timer of this.relayDraftTimers.values()) clearTimeout(timer);
    this.relayDraftTimers.clear();

    // 4. Capture agent session IDs before stopping
    const opusSid = this.opus.getSessionId();
    const claudeSid = this.claude.getSessionId();
    const codexSid = this.codex.getSessionId();
    if (opusSid) this.sessionManager?.setAgentSession('opus', opusSid);
    if (claudeSid) this.sessionManager?.setAgentSession('claude', claudeSid);
    if (codexSid) this.sessionManager?.setAgentSession('codex', codexSid);

    // 5. Kill all agents IMMEDIATELY — don't wait for session finalize first
    await Promise.allSettled([this.opus.stop(), this.claude.stop(), this.codex.stop()]);
    flog.info('ORCH', 'All agents stopped');

    // 6. Finalize session AFTER agents are dead
    await this.sessionManager?.finalize();
    flog.info('ORCH', 'Shutdown complete');
  }
}
