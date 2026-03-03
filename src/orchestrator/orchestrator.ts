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
import { ensureClaudeMd, ensureAgentsMd } from './claude-md-manager.js';
import { CrossTalkManager } from './cross-talk-manager.js';
import { BufferManager } from './buffer-manager.js';
import { DelegateTracker } from './delegate-tracker.js';
import { RelayRouter } from './relay-router.js';
import {
  CONVERSATION_SUMMARY_LIMIT,
  CONVERSATION_SUMMARY_TRUNCATE,
} from '../config/constants.js';
import {
  bindOrchestrator,
  getOpusContextReminder,
  type OrchestratorBindContext,
} from './orchestrator-bind.js';

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
  private prewarmed = false;
  private config: Omit<SessionConfig, 'task'> | null = null;
  private sessionManager: SessionManager | null = null;
  private sessionMessageHandler: ((msg: Message) => void) | null = null;
  private agentsMdWritten = true;

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

  // ── Bus listener refs (for cleanup on re-bind) ──
  private busListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  // ── Shutdown ──
  private stopping = false;

  // ── Opus pre-tag dedup ──
  private opusPreTagEmitted = false;

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

  // ── Binding (delegated to orchestrator-bind.ts) ──

  /** Build context for bindOrchestrator */
  private getBindContext(): OrchestratorBindContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      agents: this.agents,
      opus: this.opus,
      bus: this.bus,
      delegates: this.delegates,
      relay: this.relay,
      crossTalk: this.crossTalk,
      buffers: this.buffers,
      opusQueue: this.opusQueue,
      sonnetQueue: this.sonnetQueue,
      codexQueue: this.codexQueue,
      agentLastContextIndex: this.agentLastContextIndex,
      crossTalkDeferredTimers: this.crossTalkDeferredTimers,

      get stopping() { return self.stopping; },
      set stopping(v) { self.stopping = v; },
      get started() { return self.started; },
      set started(v) { self.started = v; },
      get opusPreTagEmitted() { return self.opusPreTagEmitted; },
      set opusPreTagEmitted(v) { self.opusPreTagEmitted = v; },
      get config() { return self.config; },
      set config(v) { self.config = v; },
      get opusAllMode() { return self.opusAllMode; },
      set opusAllMode(v) { self.opusAllMode = v; },
      get opusAllModeResponded() { return self.opusAllModeResponded; },
      set opusAllModeResponded(v) { self.opusAllModeResponded = v; },
      get opusAllModeWorkerTimer() { return self.opusAllModeWorkerTimer; },
      set opusAllModeWorkerTimer(v) { self.opusAllModeWorkerTimer = v; },
      get opusAllModePendingText() { return self.opusAllModePendingText; },
      set opusAllModePendingText(v) { self.opusAllModePendingText = v; },
      get opusRestartPending() { return self.opusRestartPending; },
      set opusRestartPending(v) { self.opusRestartPending = v; },
      get opusRestartTimer() { return self.opusRestartTimer; },
      set opusRestartTimer(v) { self.opusRestartTimer = v; },
      get opusRestartCount() { return self.opusRestartCount; },
      set opusRestartCount(v) { self.opusRestartCount = v; },
      MAX_OPUS_RESTARTS: this.MAX_OPUS_RESTARTS,
      get busListeners() { return self.busListeners; },
      set busListeners(v) { self.busListeners = v; },

      isAgentEnabled: (id) => this.isAgentEnabled(id),
      ensureWorkerStarted: (id) => this.ensureWorkerStarted(id),
      getWorkerReady: (id) => this.workerReady.get(id) ?? Promise.resolve(),
      sendToWorkersDirectly: (text) => this.sendToWorkersDirectly(text),
    };
  }

  bind(cb: OrchestratorCallbacks): void {
    this.callbacks = cb;
    bindOrchestrator(this.getBindContext(), cb);
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
      // When AGENTS.md was written, Codex reads its system prompt from the file.
      // Only pass the prompt as fallback when AGENTS.md is missing (user-managed).
      prompt = this.agentsMdWritten ? '' : getCodexSystemPrompt(config.projectDir);
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

  /**
   * Pre-spawn the Opus CLI process at app startup so it's ready when the
   * user types. No message is sent — the system prompt + user task will be
   * sent together on first input. Saves ~200ms of process spawn time.
   */
  async prewarmOpus(): Promise<void> {
    if (this.started || this.prewarmed || !this.config) return;
    const config = this.config;
    flog.info('ORCH', 'Pre-spawning Opus process...');

    ensureClaudeMd(config.projectDir);
    this.agentsMdWritten = ensureAgentsMd(config.projectDir);

    this.opusQueue.start();
    this.sonnetQueue.start();
    this.codexQueue.start();

    this.prewarmed = true;

    // Spawn the process with --system-prompt but no message sent (no API connection yet).
    // The user task will be sent as first message in startWithTask().
    const opusSystemPrompt = getOpusSystemPrompt(config.projectDir);
    await this.opus.start({ ...config, task: '' }, opusSystemPrompt, { prewarm: true });

    flog.info('ORCH', 'Opus process pre-spawned (waiting for first user message)');
  }

  async startWithTask(
    task: string,
    previousContext?: string,
    options?: { skipFirstMessage?: boolean },
  ): Promise<void> {
    if (this.started || !this.config) return;
    this.stopping = false;
    const config = this.config;
    flog.debug('ORCH', `Starting Opus with task: ${task.slice(0, 80)}`);

    await this.sessionManager?.createSession(task, config.projectDir);

    if (this.sessionMessageHandler) this.bus.off('message', this.sessionMessageHandler);
    this.sessionMessageHandler = (msg: Message) => this.sessionManager?.addMessage(msg);
    this.bus.on('message', this.sessionMessageHandler);

    // Build user message (task only — system prompt is passed via --system-prompt flag)
    let userMsg = task;
    if (previousContext)
      userMsg += `\n\n--- HISTORIQUE SESSION PRECEDENTE ---\n${previousContext}\n--- FIN HISTORIQUE ---`;

    // Fast path: process was pre-spawned — send task as first message
    // (no re-spawn needed, saves ~200ms)
    if (this.prewarmed) {
      this.started = true;
      this.prewarmed = false;

      if (!options?.skipFirstMessage) {
        this.opus.send(userMsg);
        flog.info('ORCH', 'Opus pre-spawned — task sent (no re-spawn)');
      } else {
        flog.info('ORCH', 'Opus pre-spawned — skipping first message (caller will send)');
      }
      return;
    }

    // Cold start path — spawn Opus with system prompt via --system-prompt flag
    ensureClaudeMd(config.projectDir);
    this.agentsMdWritten = ensureAgentsMd(config.projectDir);

    const opusSystemPrompt = getOpusSystemPrompt(config.projectDir);

    this.opusQueue.start();
    this.sonnetQueue.start();
    this.codexQueue.start();

    await this.opus.start({ ...config, task }, opusSystemPrompt);
    this.started = true;

    if (this.opus.getSessionId()) {
      const resumeMsg = previousContext
        ? `[NOUVELLE TACHE DU USER] ${task}\n\n[RESET] La session precedente a ete INTERROMPUE par le user (Echap). TOUS les agents (Sonnet, Codex) ont ete STOPPES. Tes delegations precedentes sont ANNULEES — aucun agent ne travaille. Si le user demande une action sur le code/projet, tu DOIS re-deleguer. Ne dis PAS "c'est en cours" ou "j'ai deja lance" — c'est FAUX, les agents sont morts.`
        : `[NOUVELLE TACHE DU USER] ${task}`;
      if (!options?.skipFirstMessage) {
        this.opus.send(resumeMsg);
        flog.info('ORCH', 'Opus resumed session — sent new task as follow-up');
      } else {
        flog.info('ORCH', 'Opus resumed — skipping first message (caller will send)');
      }
    } else if (!options?.skipFirstMessage) {
      // Fresh session — system prompt sent via flag, now send the task
      this.opus.send(userMsg);
      flog.info('ORCH', 'Opus cold start — task sent as first message');
    } else {
      flog.info('ORCH', 'Opus cold start — skipping first message (caller will send)');
    }

    flog.info('ORCH', 'Opus started (Sonnet, Codex on standby — lazy start)');
  }

  async restart(task: string, options?: { skipFirstMessage?: boolean }): Promise<void> {
    // Fast path: if Opus was booted at startup, reuse the session
    if (this.prewarmed) {
      flog.info('ORCH', `Fast start — Opus already booted, sending task directly`);
      await this.startWithTask(task, undefined, options);
      return;
    }

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
    await this.startWithTask(task, previousContext || undefined, options);
  }

  private buildConversationSummary(): string | null {
    const history = this.bus.getHistory();
    if (history.length === 0) return null;
    const recent = history.slice(-CONVERSATION_SUMMARY_LIMIT);
    const lines: string[] = [];
    for (const msg of recent) {
      const content = msg.content.length > CONVERSATION_SUMMARY_TRUNCATE ? msg.content.slice(0, CONVERSATION_SUMMARY_TRUNCATE) + '...' : msg.content;
      lines.push(`[${msg.from.toUpperCase()} -> ${msg.to.toUpperCase()}] ${content}`);
    }
    return lines.join('\n');
  }

  // ── User messaging ──

  sendUserMessage(text: string): void {
    this.opusAllMode = false;
    this.opusPreTagEmitted = false;
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
      const reminder = target === 'opus' ? getOpusContextReminder(this.getBindContext()) : '';
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
    const allModeTimeoutMs = loadUserConfig().crossTalkMuteTimeoutMs;
    this.opusAllModeWorkerTimer = setTimeout(() => {
      this.opusAllModeWorkerTimer = null;
      if (this.opusAllModePendingText && this.delegates.expectedDelegateCount === 0) {
        flog.info('ORCH', `@tous: Opus safety-net timer (${allModeTimeoutMs}ms) — sending to workers directly`);
        this.sendToWorkersDirectly(this.opusAllModePendingText);
      }
      this.opusAllModePendingText = null;
    }, allModeTimeoutMs);
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
    this.prewarmed = false;
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
    this.opusPreTagEmitted = false;
    this.relay.liveRelayAllowed = false;
    if (this.opusAllModeWorkerTimer) {
      clearTimeout(this.opusAllModeWorkerTimer);
      this.opusAllModeWorkerTimer = null;
    }
    this.opusAllModePendingText = null;
  }

  // ── Shutdown ──

  async stop(): Promise<void> {
    if (this.stopping) return; // idempotent — already shutting down
    this.stopping = true;
    flog.info('ORCH', 'Shutting down...');
    this.started = false;
    this.prewarmed = false;

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
