import PQueue from 'p-queue';
import { ClaudeAgent } from '../agents/claude.js';
import { CodexAgent } from '../agents/codex.js';
import { OpusAgent } from '../agents/opus.js';
import { GeminiAgent } from '../agents/gemini.js';
import type { AgentProcess, AgentId, AgentStatus, Message, OutputLine, SessionConfig } from '../agents/types.js';
import { TO_CLAUDE_PATTERN, TO_CODEX_PATTERN, TO_OPUS_PATTERN, TO_GEMINI_PATTERN } from '../agents/types.js';
import { MessageBus } from './message-bus.js';
import {
  getClaudeSystemPrompt,
  getCodexSystemPrompt,
  getOpusSystemPrompt,
  getCodexContextReminder,
  getGeminiSystemPrompt,
  getGeminiContextReminder,
} from './prompts.js';
import { flog } from '../utils/log.js';
import { SessionManager } from '../utils/session-manager.js';
import { loadUserConfig } from '../config/user-config.js';

export interface OrchestratorDeps {
  opus?: AgentProcess;
  claude?: AgentProcess;
  codex?: AgentProcess;
  gemini?: AgentProcess;
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

type WorkerAgentId = 'claude' | 'codex' | 'gemini';

export class Orchestrator {
  readonly opus: AgentProcess;
  readonly claude: AgentProcess;
  readonly codex: AgentProcess;
  readonly gemini: AgentProcess;
  readonly bus: MessageBus;
  private readonly agents: Record<AgentId, AgentProcess>;

  constructor(deps?: OrchestratorDeps) {
    this.opus = deps?.opus ?? new OpusAgent();
    this.claude = deps?.claude ?? new ClaudeAgent();
    this.codex = deps?.codex ?? new CodexAgent();
    this.gemini = deps?.gemini ?? new GeminiAgent();
    this.bus = deps?.bus ?? new MessageBus();
    this.agents = {
      opus: this.opus,
      claude: this.claude,
      codex: this.codex,
      gemini: this.gemini,
    };
  }
  private opusQueue = new PQueue({ concurrency: 1 });
  private claudeQueue = new PQueue({ concurrency: 1 });
  private codexQueue = new PQueue({ concurrency: 1 });
  private geminiQueue = new PQueue({ concurrency: 1 });
  private callbacks: OrchestratorCallbacks | null = null;
  private started = false;
  private workerStarted: Map<WorkerAgentId, boolean> = new Map([
    ['claude', false],
    ['codex', false],
    ['gemini', false],
  ]);
  private workerReady: Map<WorkerAgentId, Promise<void>> = new Map([
    ['claude', Promise.resolve()],
    ['codex', Promise.resolve()],
    ['gemini', Promise.resolve()],
  ]);
  private opusRestartPending = false;
  private opusRestartCount = 0;
  private config: Omit<SessionConfig, 'task'> | null = null;
  private relayTimestamps: number[] = [];
  private sessionMessageHandler: ((msg: Message) => void) | null = null;
  private agentLastContextIndex: Map<AgentId, number> = new Map([
    ['opus', 0],
    ['claude', 0],
    ['codex', 0],
    ['gemini', 0],
  ]);
  private sessionManager: SessionManager | null = null;
  /** Agents currently working on a relay from Opus — text output muted, actions only */
  private agentsOnRelay: Set<AgentId> = new Set();
  /** Buffer stdout while agent works on relay — flushed when relay ends */
  private relayBuffer: Map<AgentId, OutputLine[]> = new Map([
    ['claude', []],
    ['codex', []],
    ['opus', []],
    ['gemini', []],
  ]);
  /** Timestamp when relay started for each agent — used for safety timeout */
  private relayStartTime: Map<AgentId, number> = new Map();
  /** Agents that Opus delegated to — we wait for ALL before delivering to Opus */
  private expectedDelegates: Set<AgentId> = new Set();
  /** Buffered reports from delegates — delivered to Opus as one combined message */
  private pendingReportsForOpus: Map<AgentId, string> = new Map();
  /** Agents whose combined report has been delivered to Opus — mute ALL late output */
  private deliveredToOpus: Set<AgentId> = new Set();
  /** Pending safety-net timers for spawn-per-exec agents (Codex, Gemini) */
  private safetyNetTimers: Map<AgentId, ReturnType<typeof setTimeout>> = new Map();
  /** Independent timeout for expectedDelegates — prevents Opus from blocking forever */
  private delegateTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** Max time (ms) to wait for all delegates before force-delivering whatever we have */
  private readonly DELEGATE_TIMEOUT_MS = _cfg.delegateTimeoutMs;
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
      if (this.expectedDelegates.size > 0 && line.type === 'stdout') {
        // Allow only lines that are purely delegation tags or task tags to pass through
        const stripped = line.text
          .replace(/\[TO:(CLAUDE|CODEX|OPUS|GEMINI)\][^\n]*/gi, '')
          .replace(/\[FROM:(CLAUDE|CODEX|OPUS|GEMINI)\][^\n]*/gi, '')
          .replace(/\[TASK:(add|done)\][^\n]*/gi, '')
          .trim();
        if (stripped.length > 0) {
          flog.debug('BUFFER', `Opus stdout BUFFERED (${this.expectedDelegates.size} delegates pending): ${stripped.slice(0, 80)}`, { agent: 'opus' });
          this.relayBuffer.get('opus')!.push(line);
          return;
        }
      }
      cb.onAgentOutput('opus', line);
    });
    this.opus.onStatusChange((s) => {
      flog.info('AGENT', `opus: ${s}`, { agent: 'opus' });
      cb.onAgentStatus('opus', s);
      if (s === 'running') {
        this.opusRestartCount = 0;
      }
      if ((s === 'error' || s === 'stopped') && this.started && !this.opusRestartPending) {
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
        setTimeout(async () => {
          this.opusRestartPending = false;
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

    // Bind worker agents (Claude, Codex, Gemini) — shared output/status handlers
    this.bindWorkerAgent('claude', this.claude, cb);
    this.bindWorkerAgent('codex', this.codex, cb);
    this.bindWorkerAgent('gemini', this.gemini, cb);

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
    this.bindWorkerRoute(
      'gemini',
      this.geminiQueue,
      () => this.ensureWorkerStarted('gemini'),
      () => this.workerReady.get('gemini') ?? Promise.resolve(),
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

  /** Bind output and status handlers for a worker agent (Claude, Codex, Gemini).
   *  Claude uses immediate auto-relay (stream-based); Codex/Gemini use timer-based safety-net. */
  private bindWorkerAgent(agentId: AgentId, agent: AgentProcess, cb: OrchestratorCallbacks) {
    const label = agentId.charAt(0).toUpperCase() + agentId.slice(1);
    // true for spawn-per-exec agents — they fire 'waiting' after EACH exec
    const usesTimerSafetyNet = agentId === 'codex' || agentId === 'gemini';
    // For spawn-per-exec agents, cross-talk mute needs longer threshold before clearing
    const crossTalkClearThreshold = usesTimerSafetyNet ? 2_000 : 3_000;

    agent.onOutput((line) => {
      flog.debug('AGENT', 'Output', { agent: agentId, type: line.type, text: line.text.slice(0, 150) });
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
            this.relayBuffer.get(agentId)!.push(line);
          }
          if (line.type !== 'stdout') cb.onAgentOutput(agentId, line);
          return;
        }
      }
      if (this.agentsOnRelay.has(agentId)) {
        const start = this.relayStartTime.get(agentId) ?? 0;
        if (Date.now() - start > this.RELAY_TIMEOUT_MS) {
          this.agentsOnRelay.delete(agentId);
          this.relayBuffer.set(agentId, []);
          this.relayStartTime.delete(agentId);
          flog.warn('ORCH', `${label} relay timeout (${this.RELAY_TIMEOUT_MS / 1000}s) — unmuting`);
        } else {
          this.detectRelayPatterns(agentId, line.text);
          if (line.type === 'stdout') {
            flog.debug('BUFFER', 'On relay for opus', { agent: agentId });
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
          this.pendingReportsForOpus.set(agentId, `(agent ${s} — pas de rapport)`);
          if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
            this.deliverCombinedReportsToOpus();
          }
        }
        if (!this.isOpusWaitingForRelays() && this.callbacks) {
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
      flog.info('ORCH', 'Lazy-starting Gemini...');
      prompt = getGeminiSystemPrompt(config.projectDir);
      this.gemini.setContextReminder?.(getGeminiContextReminder(config.projectDir));
      agent = this.gemini;
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

    flog.info('ORCH', 'Opus started (Sonnet, Codex, Gemini on standby — lazy start)');
  }

  get isStarted() {
    return this.started;
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
    this.crossTalkCount = 0;
    // Cancel all safety-net timers
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();

    for (const agent of ['claude', 'codex', 'opus', 'gemini'] as AgentId[]) {
      if (this.callbacks) {
        for (const buffered of this.relayBuffer.get(agent) ?? []) {
          this.callbacks.onAgentOutput(agent, buffered);
        }
      }
      this.relayBuffer.set(agent, []);
    }
    // Send LIVE to running agents, normal bus.send to idle ones
    for (const agentId of ['opus', 'claude', 'codex', 'gemini'] as AgentId[]) {
      const agent = this.getAgent(agentId);
      if (agent.status === 'running') {
        agent.sendUrgent(`[FROM:USER] ${text}`);
        // Record in bus history
        this.bus.record({ from: 'user', to: agentId, content: text });
      } else {
        this.bus.send({ from: 'user', to: agentId, content: text });
      }
    }
  }

  private resetState() {
    this.started = false;
    this.opusRestartPending = false;
    this.opusRestartCount = 0;
    this.workerStarted = new Map([
      ['claude', false],
      ['codex', false],
      ['gemini', false],
    ]);
    this.workerReady = new Map([
      ['claude', Promise.resolve()],
      ['codex', Promise.resolve()],
      ['gemini', Promise.resolve()],
    ]);
    this.agentLastContextIndex = new Map([
      ['opus', 0],
      ['claude', 0],
      ['codex', 0],
      ['gemini', 0],
    ]);
    this.agentsOnRelay.clear();
    this.agentsOnCrossTalk.clear();
    this.awaitingCrossTalkReply.clear();
    this.relayBuffer = new Map([
      ['claude', []],
      ['codex', []],
      ['opus', []],
      ['gemini', []],
    ]);
    this.relayStartTime.clear();
    this.relayTimestamps = [];
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.deliveredToOpus.clear();
    this.crossTalkCount = 0;
    this.lastDelegationContent.clear();
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();
    if (this.delegateTimeoutTimer) {
      clearTimeout(this.delegateTimeoutTimer);
      this.delegateTimeoutTimer = null;
    }
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
      TO_CLAUDE_PATTERN.test(line) || TO_CODEX_PATTERN.test(line) || TO_OPUS_PATTERN.test(line) || TO_GEMINI_PATTERN.test(line)
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
    if (from !== 'gemini') {
      const m = line.match(TO_GEMINI_PATTERN);
      if (m) return { target: 'gemini', firstLine: m[1].trim() };
    }
    return null;
  }

  /** Resolve an AgentId to the corresponding agent instance */
  private getAgent(id: AgentId) {
    return this.agents[id];
  }

  /** Detect [TO:*] relay tags in agent output and route messages.
   *  Returns true if at least one relay tag was found and processed. */
  private detectRelayPatterns(from: AgentId, text: string): boolean {
    const rateLimited = this.isRelayRateLimited();
    if (rateLimited) {
      flog.warn('ORCH', `Relay rate limited — skipping from ${from}`);
      this.callbacks?.onAgentOutput(from, {
        text: '[Rate limit] Trop de relays — patientez quelques secondes.',
        timestamp: Date.now(),
        type: 'info',
      });
      return false;
    }

    // Pre-process: split lines that contain multiple [TO:*] tags on the same line
    // e.g. "[TO:GEMINI] [TO:CODEX] Hello" → "[TO:GEMINI]" and "[TO:CODEX] Hello"
    const rawLines = text.split('\n');
    const lines: string[] = [];
    const multiTagRe = /(\[TO:(?:CLAUDE|CODEX|OPUS|GEMINI)\])/g;
    for (const raw of rawLines) {
      const tags: { idx: number; len: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = multiTagRe.exec(raw)) !== null) {
        tags.push({ idx: m.index, len: m[0].length });
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

    let i = 0;
    let foundRelay = false;
    while (i < lines.length) {
      const line = lines[i];

      // Try to match a [TO:*] relay tag on this line
      const match = this.matchRelayTag(line, from);
      if (!match) {
        i++;
        continue;
      }
      foundRelay = true;

      const { target, firstLine } = match;

      // Capture rest until next [TO:*] tag or end of text
      const restLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !this.isRelayTag(lines[j])) {
        restLines.push(lines[j]);
        j++;
      }
      const rest = restLines.join('\n').trim();
      // Build content: firstLine may be empty if tag was alone on its line (Codex style)
      const content = [firstLine, rest].filter(Boolean).join('\n');

      if (content) {
        flog.info('RELAY', `${from}->${target}: ${content.slice(0, 80)}`);

        // ── Cross-talk: peer-to-peer between agents (not via Opus) ──
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
        } else {
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
          } else {
            this.bus.relay(from, target, content);
            // Keep muted until the agent finishes — safety-net on 'waiting' will auto-relay
            if (target === 'opus' && from !== 'opus') {
              this.relayBuffer.set(from, []);
            }
          }
        }
      }

      i = j; // Skip consumed lines, continue to next potential relay
    }
    return foundRelay;
  }

  /** Reset the independent delegate timeout — called each time a new delegate is added */
  private resetDelegateTimeout() {
    if (this.delegateTimeoutTimer) clearTimeout(this.delegateTimeoutTimer);
    this.delegateTimeoutTimer = setTimeout(() => {
      this.delegateTimeoutTimer = null;
      if (this.expectedDelegates.size === 0) return;
      flog.warn('ORCH', `Delegate timeout (${this.DELEGATE_TIMEOUT_MS / 1000}s) — force-delivering ${this.pendingReportsForOpus.size}/${this.expectedDelegates.size} reports`);
      // Fill in placeholder reports for any delegates that haven't reported
      for (const delegate of this.expectedDelegates) {
        if (!this.pendingReportsForOpus.has(delegate)) {
          this.pendingReportsForOpus.set(delegate, '(timeout — pas de rapport)');
        }
      }
      this.deliverCombinedReportsToOpus();
    }, this.DELEGATE_TIMEOUT_MS);
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
      const fallback = this.pickFallbackAgent(agent);
      if (fallback && this.expectedDelegates.has(agent)) {
        const originalTask = this.lastDelegationContent.get(agent);
        if (originalTask) {
          flog.info('ORCH', `Auto-fallback: ${agent} failed → redelegating to ${fallback}`);
          // Remove failed agent from expected, add fallback
          this.expectedDelegates.delete(agent);
          this.expectedDelegates.add(fallback);
          this.deliveredToOpus.delete(fallback);
          this.agentsOnRelay.add(fallback);
          this.relayStartTime.set(fallback, Date.now());
          this.recordRelay();
          this.bus.relay('opus', fallback, `[FALLBACK — ${agent} a echoue] ${originalTask}`);
          // Notify via UI
          if (this.callbacks) {
            this.callbacks.onAgentOutput(agent, {
              text: `${agent} indisponible — tache transferee a ${fallback}`,
              timestamp: Date.now(),
              type: 'info',
            });
          }
        } else {
          // No original task content — just send placeholder
          if (this.expectedDelegates.has(agent)) {
            this.pendingReportsForOpus.set(agent, placeholder);
            if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
              this.deliverCombinedReportsToOpus();
            }
          }
        }
      } else {
        if (this.expectedDelegates.has(agent)) {
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
    if (!this.isOpusWaitingForRelays() && this.callbacks) {
      this.flushOpusBuffer(this.callbacks);
    }
  }

  /** Pick a fallback agent when one fails. Returns null if no fallback available. */
  private pickFallbackAgent(failedAgent: AgentId): AgentId | null {
    // Gemini failed → prefer Claude (frontend) or Codex (backend) — pick whichever is not already a delegate
    // Sonnet failed → Codex can do both front and back
    // Codex failed → Sonnet can do both front and back
    const fallbackMap: Record<string, AgentId[]> = {
      gemini: ['claude', 'codex'],
      claude: ['codex'],
      codex: ['claude'],
    };
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
    // All candidates are already delegates or unhealthy — no fallback possible
    return null;
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
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.crossTalkCount = 0;
    // Clear delegate timeout — delivery complete
    if (this.delegateTimeoutTimer) {
      clearTimeout(this.delegateTimeoutTimer);
      this.delegateTimeoutTimer = null;
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

    // 1. Clear all queues FIRST — prevent new messages from being sent to agents
    this.opusQueue.clear();
    this.claudeQueue.clear();
    this.codexQueue.clear();
    this.geminiQueue.clear();

    // 2. Cancel all safety-net and delegate timers
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();
    if (this.delegateTimeoutTimer) {
      clearTimeout(this.delegateTimeoutTimer);
      this.delegateTimeoutTimer = null;
    }

    // 3. Clear all relay/mute state so no stale handlers fire
    this.agentsOnRelay.clear();
    this.agentsOnCrossTalk.clear();
    this.awaitingCrossTalkReply.clear();
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.deliveredToOpus.clear();

    // 4. Capture agent session IDs before stopping
    const opusSid = this.opus.getSessionId();
    const claudeSid = this.claude.getSessionId();
    const codexSid = this.codex.getSessionId();
    const geminiSid = this.gemini.getSessionId();
    if (opusSid) this.sessionManager?.setAgentSession('opus', opusSid);
    if (claudeSid) this.sessionManager?.setAgentSession('claude', claudeSid);
    if (codexSid) this.sessionManager?.setAgentSession('codex', codexSid);
    if (geminiSid) this.sessionManager?.setAgentSession('gemini', geminiSid);

    // 5. Kill all agents IMMEDIATELY — don't wait for session finalize first
    await Promise.allSettled([this.opus.stop(), this.claude.stop(), this.codex.stop(), this.gemini.stop()]);
    flog.info('ORCH', 'All agents stopped');

    // 6. Finalize session AFTER agents are dead
    await this.sessionManager?.finalize();
    flog.info('ORCH', 'Shutdown complete');
  }
}
