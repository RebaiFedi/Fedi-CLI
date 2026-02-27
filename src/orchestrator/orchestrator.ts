import PQueue from 'p-queue';
import { ClaudeAgent } from '../agents/claude.js';
import { CodexAgent } from '../agents/codex.js';
import { OpusAgent } from '../agents/opus.js';
import type { AgentId, AgentStatus, Message, OutputLine, SessionConfig } from '../agents/types.js';
import { TO_CLAUDE_PATTERN, TO_CODEX_PATTERN, TO_OPUS_PATTERN } from '../agents/types.js';
import { MessageBus } from './message-bus.js';
import {
  getClaudeSystemPrompt,
  getCodexSystemPrompt,
  getOpusSystemPrompt,
  getCodexContextReminder,
} from './prompts.js';
import { logger } from '../utils/logger.js';
import { SessionManager } from '../utils/session-manager.js';
import {
  traceAgentOutput,
  traceAgentStatus,
  traceBuffered,
  traceRelay,
  traceRelayBlocked,
  traceRelayState,
  traceOpusFlush,
  traceBusMessage,
  trace,
} from '../utils/trace.js';

/** Max relays within a time window before blocking */
const RELAY_WINDOW_MS = 60_000;
const MAX_RELAYS_PER_WINDOW = 12;

export interface OrchestratorCallbacks {
  onAgentOutput: (agent: AgentId, line: OutputLine) => void;
  onAgentStatus: (agent: AgentId, status: AgentStatus) => void;
  onRelay: (msg: Message) => void;
  onRelayBlocked: (msg: Message) => void;
}

export class Orchestrator {
  readonly opus = new OpusAgent();
  readonly claude = new ClaudeAgent();
  readonly codex = new CodexAgent();
  readonly bus = new MessageBus();
  private opusQueue = new PQueue({ concurrency: 1 });
  private claudeQueue = new PQueue({ concurrency: 1 });
  private codexQueue = new PQueue({ concurrency: 1 });
  private callbacks: OrchestratorCallbacks | null = null;
  private started = false;
  private claudeStarted = false;
  private codexStarted = false;
  private codexReady: Promise<void> = Promise.resolve();
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
  /** Cross-talk message counter — reset each round, blocks after MAX */
  private crossTalkCount = 0;
  private readonly MAX_CROSS_TALK_PER_ROUND = 4;
  /** Agents responding to a cross-talk message — stdout muted until timeout or next user interaction */
  private agentsOnCrossTalk: Map<AgentId, number> = new Map(); // agentId → timestamp when set

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
      traceAgentOutput('opus', line);
      this.detectRelayPatterns('opus', line.text);

      // When Opus has active delegates, buffer long text output (he tends to write
      // partial reports before all agents finish). Short messages pass through.
      if (this.isOpusWaitingForRelays() && line.type === 'stdout') {
        // Strip delegation tags, task tags, and [FROM:*] to measure actual user-facing text
        const userText = line.text
          .replace(/\[TO:(CLAUDE|CODEX|OPUS)\][^\n]*/gi, '')
          .replace(/\[FROM:(CLAUDE|CODEX|OPUS)\][^\n]*/gi, '')
          .replace(/\[TASK:(add|done)\][^\n]*/gi, '')
          .trim();
        if (userText.length > 200) {
          traceBuffered('opus', 'partial report — still waiting for delegates');
          this.relayBuffer.get('opus')!.push(line);
          return;
        }
      }
      cb.onAgentOutput('opus', line);
    });
    this.opus.onStatusChange((s) => {
      traceAgentStatus('opus', s);
      cb.onAgentStatus('opus', s);
    });

    // Claude output & status — buffer text when on relay, forward actions for live display
    this.claude.onOutput((line) => {
      traceAgentOutput('claude', line);
      // Cross-talk mute — agent is responding to a peer message, suppress stdout
      if (this.agentsOnCrossTalk.has('claude')) {
        const muteTime = this.agentsOnCrossTalk.get('claude')!;
        if (Date.now() - muteTime > 30_000) {
          logger.warn('[ORCH] Claude cross-talk mute timeout (30s) — unmuting');
          this.agentsOnCrossTalk.delete('claude');
        } else {
          this.detectRelayPatterns('claude', line.text);
          // If also on relay, capture stdout in buffer for the Opus report
          if (this.agentsOnRelay.has('claude') && line.type === 'stdout') {
            traceBuffered('claude', 'on cross-talk + relay for opus');
            this.relayBuffer.get('claude')!.push(line);
          }
          if (line.type !== 'stdout') cb.onAgentOutput('claude', line);
          return;
        }
      }
      if (this.agentsOnRelay.has('claude')) {
        const start = this.relayStartTime.get('claude') ?? 0;
        if (Date.now() - start > 120_000) {
          this.agentsOnRelay.delete('claude');
          this.relayBuffer.set('claude', []);
          this.relayStartTime.delete('claude');
          logger.warn('[ORCH] Claude relay timeout (120s) — unmuting');
        } else {
          this.detectRelayPatterns('claude', line.text);
          if (line.type === 'stdout') {
            traceBuffered('claude', 'on relay for opus');
            this.relayBuffer.get('claude')!.push(line);
          } else {
            // Forward actions (system/info) so user sees live activity
            cb.onAgentOutput('claude', line);
          }
          return;
        }
      }
      cb.onAgentOutput('claude', line);
      this.detectRelayPatterns('claude', line.text);
    });
    this.claude.onStatusChange((s) => {
      traceAgentStatus('claude', s);
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        const muteTime = this.agentsOnCrossTalk.get('claude');
        if (muteTime !== undefined) {
          const elapsed = Date.now() - muteTime;
          if (elapsed > 3_000 || s === 'stopped' || s === 'error') {
            this.agentsOnCrossTalk.delete('claude');
          }
        }
      }
      if (s === 'stopped' || s === 'error') {
        traceRelayState('claude', 'end', `status=${s}`);
        this.agentsOnRelay.delete('claude');
        this.relayBuffer.set('claude', []);
        this.relayStartTime.delete('claude');
        // If expected delegate crashed, provide placeholder and check combined delivery
        if (this.expectedDelegates.has('claude') && !this.pendingReportsForOpus.has('claude')) {
          this.pendingReportsForOpus.set('claude', `(agent ${s} — pas de rapport)`);
          if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
            this.deliverCombinedReportsToOpus();
          }
        }
        if (!this.isOpusWaitingForRelays() && this.callbacks) {
          this.flushOpusBuffer(this.callbacks);
        }
      }
      // Safety net: Claude finished relay without [TO:OPUS] → auto-relay buffer
      if (s === 'waiting' && this.agentsOnRelay.has('claude')) {
        const buffer = this.relayBuffer.get('claude') ?? [];
        const textLines = buffer
          .filter((l) => l.type === 'stdout')
          .map((l) => l.text)
          .filter((t) => !this.isRelayTag(t))
          .join('\n')
          .trim();
        if (textLines) {
          logger.info(
            `[ORCH] Claude finished on relay without [TO:OPUS] — auto-relaying ${textLines.length} chars`,
          );
          // If gathering delegates, buffer the report instead of relaying directly
          if (this.expectedDelegates.has('claude')) {
            this.pendingReportsForOpus.set('claude', textLines);
            logger.info(`[ORCH] Auto-buffered Claude report (${this.pendingReportsForOpus.size}/${this.expectedDelegates.size})`);
            if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
              this.deliverCombinedReportsToOpus();
            }
          } else {
            this.recordRelay();
            this.bus.relay('claude', 'opus', textLines);
          }
        } else {
          logger.warn('[ORCH] Claude finished on relay — no buffered text to relay');
          // If expected delegate but no text, remove from expected with placeholder
          if (this.expectedDelegates.has('claude')) {
            this.pendingReportsForOpus.set('claude', '(pas de rapport)');
            if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
              this.deliverCombinedReportsToOpus();
            }
          }
        }
        this.agentsOnRelay.delete('claude');
        this.relayBuffer.set('claude', []);
        this.relayStartTime.delete('claude');
        // If no more active delegates → flush Opus buffer
        if (!this.isOpusWaitingForRelays() && this.callbacks) {
          this.flushOpusBuffer(this.callbacks);
        }
      }
      cb.onAgentStatus('claude', s);
    });

    // Codex output & status — buffer text when on relay, forward actions for live display
    this.codex.onOutput((line) => {
      traceAgentOutput('codex', line);
      // Cross-talk mute — agent is responding to a peer message, suppress stdout
      if (this.agentsOnCrossTalk.has('codex')) {
        const muteTime = this.agentsOnCrossTalk.get('codex')!;
        if (Date.now() - muteTime > 30_000) {
          logger.warn('[ORCH] Codex cross-talk mute timeout (30s) — unmuting');
          this.agentsOnCrossTalk.delete('codex');
        } else {
          logger.info(`[ORCH] Codex output MUTED (cross-talk): ${line.text.slice(0, 80)}`);
          this.detectRelayPatterns('codex', line.text);
          // If also on relay, capture stdout in buffer for the Opus report
          if (this.agentsOnRelay.has('codex') && line.type === 'stdout') {
            traceBuffered('codex', 'on cross-talk + relay for opus');
            this.relayBuffer.get('codex')!.push(line);
          }
          if (line.type !== 'stdout') cb.onAgentOutput('codex', line);
          return;
        }
      }
      if (this.agentsOnRelay.has('codex')) {
        const start = this.relayStartTime.get('codex') ?? 0;
        if (Date.now() - start > 120_000) {
          this.agentsOnRelay.delete('codex');
          this.relayBuffer.set('codex', []);
          this.relayStartTime.delete('codex');
          logger.warn('[ORCH] Codex relay timeout (120s) — unmuting');
        } else {
          this.detectRelayPatterns('codex', line.text);
          if (line.type === 'stdout') {
            traceBuffered('codex', 'on relay for opus');
            this.relayBuffer.get('codex')!.push(line);
          } else {
            // Forward actions (system/info) so user sees live activity
            cb.onAgentOutput('codex', line);
          }
          return;
        }
      }
      cb.onAgentOutput('codex', line);
      this.detectRelayPatterns('codex', line.text);
    });
    this.codex.onStatusChange((s) => {
      traceAgentStatus('codex', s);
      if (s === 'waiting' || s === 'stopped' || s === 'error') {
        const muteTime = this.agentsOnCrossTalk.get('codex');
        if (muteTime !== undefined) {
          const elapsed = Date.now() - muteTime;
          // Codex uses exec() per message — ignore spurious 'waiting' from earlier execs.
          // Only clear after enough time for the cross-talk exec to have run.
          if (elapsed > 2_000 || s === 'stopped' || s === 'error') {
            logger.info(`[ORCH] Cross-talk MUTE CLEARED for codex (status=${s}, elapsed=${elapsed}ms)`);
            this.agentsOnCrossTalk.delete('codex');
          } else {
            logger.info(`[ORCH] Cross-talk mute kept for codex (status=${s}, elapsed=${elapsed}ms — too soon, likely stale exec)`);
          }
        }
      }
      if (s === 'stopped' || s === 'error') {
        traceRelayState('codex', 'end', `status=${s}`);
        this.agentsOnRelay.delete('codex');
        this.relayBuffer.set('codex', []);
        this.relayStartTime.delete('codex');
        // If expected delegate crashed, provide placeholder and check combined delivery
        if (this.expectedDelegates.has('codex') && !this.pendingReportsForOpus.has('codex')) {
          this.pendingReportsForOpus.set('codex', `(agent ${s} — pas de rapport)`);
          if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
            this.deliverCombinedReportsToOpus();
          }
        }
        if (!this.isOpusWaitingForRelays() && this.callbacks) {
          this.flushOpusBuffer(this.callbacks);
        }
      }
      // Safety net: Codex proc.exit → si encore en relay, auto-relay le buffer
      if (s === 'waiting' && this.agentsOnRelay.has('codex')) {
        const buffer = this.relayBuffer.get('codex') ?? [];
        const textLines = buffer
          .filter((l) => l.type === 'stdout')
          .map((l) => l.text)
          .filter((t) => !this.isRelayTag(t))
          .join('\n')
          .trim();
        if (textLines) {
          logger.info(
            `[ORCH] Codex finished on relay without [TO:OPUS] — auto-relaying ${textLines.length} chars`,
          );
          // If gathering delegates, buffer the report instead of relaying directly
          if (this.expectedDelegates.has('codex')) {
            this.pendingReportsForOpus.set('codex', textLines);
            logger.info(`[ORCH] Auto-buffered Codex report (${this.pendingReportsForOpus.size}/${this.expectedDelegates.size})`);
            if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
              this.deliverCombinedReportsToOpus();
            }
          } else {
            this.recordRelay();
            this.bus.relay('codex', 'opus', textLines);
          }
        } else {
          logger.warn('[ORCH] Codex finished on relay — no buffered text to relay');
          // If expected delegate but no text, remove from expected with placeholder
          if (this.expectedDelegates.has('codex')) {
            this.pendingReportsForOpus.set('codex', '(pas de rapport)');
            if (this.pendingReportsForOpus.size >= this.expectedDelegates.size) {
              this.deliverCombinedReportsToOpus();
            }
          }
        }
        this.agentsOnRelay.delete('codex');
        this.relayBuffer.set('codex', []);
        this.relayStartTime.delete('codex');
        // If no more active delegates → flush Opus buffer
        if (!this.isOpusWaitingForRelays() && this.callbacks) {
          this.flushOpusBuffer(this.callbacks);
        }
      }
      cb.onAgentStatus('codex', s);
    });

    this.bus.on('relay', (msg: Message) => {
      traceRelay(msg.from as AgentId, msg.to as AgentId, msg.content);
      cb.onRelay(msg);
    });
    this.bus.on('relay-blocked', (msg: Message) => {
      traceRelayBlocked(msg.from as AgentId, msg.to as AgentId);
      cb.onRelayBlocked(msg);
    });

    // Route messages to Opus — inject cross-agent context
    this.bus.on('message:opus', (msg: Message) => {
      traceBusMessage(msg);
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

    // Route messages to Claude (lazy start) — inject cross-agent context
    this.bus.on('message:claude', (msg: Message) => {
      traceBusMessage(msg);
      if (msg.from === 'claude') return;
      this.claudeQueue.add(async () => {
        await this.ensureClaudeStarted();
        // Refresh cross-talk mute right before send — prevents stale status
        // transitions from clearing the mute during the async queue wait
        if (this.agentsOnCrossTalk.has('claude')) {
          this.agentsOnCrossTalk.set('claude', Date.now());
        }
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        const context = this.getNewContext('claude');
        let payload = `${prefix} ${msg.content}`;
        if (context) {
          payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
        }
        this.claude.send(payload);
      });
    });

    // Route messages to Codex (lazy start) — inject cross-agent context
    this.bus.on('message:codex', (msg: Message) => {
      traceBusMessage(msg);
      if (msg.from === 'codex') return;
      this.codexQueue.add(async () => {
        await this.ensureCodexStarted();
        await this.codexReady; // Wait for start() to fully complete before sending
        // Refresh cross-talk mute right before send — prevents stale status
        // transitions from clearing the mute during the async queue wait
        if (this.agentsOnCrossTalk.has('codex')) {
          this.agentsOnCrossTalk.set('codex', Date.now());
        }
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        const context = this.getNewContext('codex');
        let payload = `${prefix} ${msg.content}`;
        if (context) {
          payload += `\n\n--- CONTEXTE ---\n${context}\n--- FIN ---`;
        }
        this.codex.send(payload);
      });
    });
  }

  /** Start Claude on first message to it — includes recent bus history */
  private async ensureClaudeStarted() {
    if (this.claudeStarted || !this.config) return;
    this.claudeStarted = true;
    const config = this.config;
    logger.info('[ORCH] Lazy-starting Claude...');
    let prompt = getClaudeSystemPrompt(config.projectDir);
    // Inject recent history so Sonnet knows why it's being called
    const { summary, newIndex } = this.bus.getContextSummary('claude', 0, 5);
    this.agentLastContextIndex.set('claude', newIndex);
    if (summary) {
      prompt += `\n\n--- HISTORIQUE ---\n${summary}\n--- FIN ---`;
    }
    await this.claude.start({ ...config, task: '' }, prompt);
  }

  /** Start Codex on first message to it — includes recent bus history */
  private async ensureCodexStarted(options?: { muted?: boolean }) {
    if (this.codexStarted || !this.config) return;
    this.codexStarted = true;
    const config = this.config;
    logger.info(`[ORCH] ${options?.muted ? 'Eager' : 'Lazy'}-starting Codex...`);
    let prompt = getCodexSystemPrompt(config.projectDir);
    // Inject recent history so Codex knows why it's being called
    const { summary, newIndex } = this.bus.getContextSummary('codex', 0, 5);
    this.agentLastContextIndex.set('codex', newIndex);
    if (summary) {
      prompt += `\n\n--- HISTORIQUE ---\n${summary}\n--- FIN ---`;
    }
    // Set compact reminder for session loss recovery
    this.codex.setContextReminder(getCodexContextReminder(config.projectDir));
    this.codexReady = this.codex.start({ ...config, task: '' }, prompt, { muted: options?.muted });
    await this.codexReady;
  }

  /** Start with first user message. Only Opus starts immediately. */
  async startWithTask(task: string) {
    if (this.started || !this.config) return;
    this.started = true;

    const config = this.config;
    logger.info(`[ORCH] Starting Opus with task: ${task.slice(0, 80)}`);

    // Create persistent session
    await this.sessionManager?.createSession(task, config.projectDir);

    // Listen for all bus messages → persist them (cleanup old handler first)
    if (this.sessionMessageHandler) {
      this.bus.off('message', this.sessionMessageHandler);
    }
    this.sessionMessageHandler = (msg: Message) => this.sessionManager?.addMessage(msg);
    this.bus.on('message', this.sessionMessageHandler);

    // Only Opus starts immediately — Claude starts lazily when Opus delegates
    const opusPrompt = getOpusSystemPrompt(config.projectDir) + `\n\nMESSAGE DU USER: ${task}`;
    await this.opus.start({ ...config, task }, opusPrompt);

    logger.info('[ORCH] Opus started (Claude on standby)');

    // Start Codex eagerly in background (muted — no output until @codex or relay)
    this.ensureCodexStarted({ muted: true }).catch((err) =>
      logger.error(`[ORCH] Codex eager start failed: ${err}`),
    );
  }

  get isStarted() {
    return this.started;
  }

  /** Restart after stop — reset state and start fresh with new task */
  async restart(task: string) {
    // Reset internal state
    this.started = false;
    this.claudeStarted = false;
    this.codexStarted = false;
    this.codexReady = Promise.resolve();
    this.agentLastContextIndex = new Map([
      ['opus', 0],
      ['claude', 0],
      ['codex', 0],
    ]);
    this.agentsOnRelay.clear();
    this.agentsOnCrossTalk.clear();
    this.relayBuffer = new Map([
      ['claude', []],
      ['codex', []],
      ['opus', []],
    ]);
    this.relayStartTime.clear();
    this.relayTimestamps = [];
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.crossTalkCount = 0;


    // Cleanup session message listener before re-registering in startWithTask
    if (this.sessionMessageHandler) {
      this.bus.off('message', this.sessionMessageHandler);
      this.sessionMessageHandler = null;
    }

    // Reset bus history
    this.bus.reset();

    // Start fresh
    await this.startWithTask(task);
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
    this.expectedDelegates.delete(agent);
    this.pendingReportsForOpus.delete(agent);
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

  sendToAll(text: string) {
    this.bus.send({ from: 'user', to: 'opus', content: text });
    this.bus.send({ from: 'user', to: 'claude', content: text });
    this.bus.send({ from: 'user', to: 'codex', content: text });
  }

  /** Send message directly from user to all 3 agents — agents respond directly, no relay buffering */
  sendToAllDirect(text: string) {
    // Clear all relay state so agents respond directly (not buffered for Opus)
    this.agentsOnRelay.clear();
    this.agentsOnCrossTalk.clear();
    this.relayStartTime.clear();
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.crossTalkCount = 0;

    for (const agent of ['claude', 'codex', 'opus'] as AgentId[]) {
      if (this.callbacks) {
        for (const buffered of this.relayBuffer.get(agent) ?? []) {
          this.callbacks.onAgentOutput(agent, buffered);
        }
      }
      this.relayBuffer.set(agent, []);
    }
    // Send LIVE to running agents, normal bus.send to idle ones
    for (const agentId of ['opus', 'claude', 'codex'] as AgentId[]) {
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

  private isRelayRateLimited(): boolean {
    const now = Date.now();
    this.relayTimestamps = this.relayTimestamps.filter((t) => now - t < RELAY_WINDOW_MS);
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
    return id === 'opus' ? this.opus : id === 'claude' ? this.claude : this.codex;
  }

  private detectRelayPatterns(from: AgentId, text: string) {
    if (this.isRelayRateLimited()) {
      logger.warn(`[ORCH] Relay rate limited — skipping from ${from}`);
      return;
    }

    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      if (this.isRelayRateLimited()) break;
      const line = lines[i];

      // Try to match a [TO:*] relay tag on this line
      const match = this.matchRelayTag(line, from);
      if (!match) {
        i++;
        continue;
      }

      const { target, firstLine } = match;

      // Capture rest until next [TO:*] tag or end of text
      const restLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !this.isRelayTag(lines[j])) {
        restLines.push(lines[j]);
        j++;
      }
      const rest = restLines.join('\n').trim();
      const content = rest ? `${firstLine}\n${rest}` : firstLine;

      if (content) {
        logger.info(`[ORCH] Relay: ${from} → ${target}: ${content.slice(0, 80)}`);

        // ── Cross-talk: peer-to-peer between claude ↔ codex (not via Opus) ──
        const isPeerToPeer =
          from !== 'opus' && target !== 'opus' && from !== target;

        if (isPeerToPeer) {
          if (this.crossTalkCount >= this.MAX_CROSS_TALK_PER_ROUND) {
            logger.warn(
              `[ORCH] Cross-talk limit reached (${this.crossTalkCount}/${this.MAX_CROSS_TALK_PER_ROUND}) — blocking ${from} → ${target}`,
            );
            // Don't relay — agents will continue their own work
          } else {
            this.crossTalkCount++;
            logger.info(
              `[ORCH] Cross-talk ${this.crossTalkCount}/${this.MAX_CROSS_TALK_PER_ROUND}: ${from} → ${target}`,
            );
            // Mute the target agent's stdout — cross-talk response is internal
            this.agentsOnCrossTalk.set(target, Date.now());
            logger.info(`[ORCH] Cross-talk MUTE SET for ${target}`);
            this.recordRelay();
            this.bus.relay(from, target, content);
          }
        } else {
          // ── Standard delegation / report flow ──
          if (from === 'opus' && target !== 'opus') {
            this.agentsOnRelay.add(target);
            this.relayStartTime.set(target, Date.now());
            this.expectedDelegates.add(target);
            logger.info(`[ORCH] Expected delegates: ${[...this.expectedDelegates].join(', ')}`);
          }
          this.recordRelay();
          // Agent reporting back to Opus — buffer the report instead of delivering immediately.
          // When ALL expected delegates have reported, deliver a combined message.
          if (target === 'opus' && from !== 'opus' && this.expectedDelegates.has(from as AgentId)) {
            this.pendingReportsForOpus.set(from as AgentId, content);
            this.relayBuffer.set(from, []);
            logger.info(`[ORCH] Buffered report from ${from} (${this.pendingReportsForOpus.size}/${this.expectedDelegates.size} received)`);
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
      trace(`[OPUS] Discarding ${buffer.length} buffered partial report lines (delegates done — Opus will write fresh synthesis)`);
    }
    this.relayBuffer.set('opus', []);
  }

  /** Deliver all pending delegate reports as ONE combined message to Opus */
  private deliverCombinedReportsToOpus() {
    if (this.pendingReportsForOpus.size === 0) return;

    const parts: string[] = [];
    for (const [agent, report] of this.pendingReportsForOpus) {
      parts.push(`[FROM:${agent.toUpperCase()}] ${report}`);
    }
    const combined = parts.join('\n\n---\n\n');
    logger.info(`[ORCH] Delivering combined report to Opus (${this.pendingReportsForOpus.size} delegates): ${combined.slice(0, 120)}`);

    // Clear delegate tracking + reset cross-talk counter for next round
    // to a cross-talk message. They clear themselves on status → waiting.
    this.expectedDelegates.clear();
    this.pendingReportsForOpus.clear();
    this.crossTalkCount = 0;

    // Deliver as a single message via the bus
    this.recordRelay();
    this.bus.send({ from: 'system', to: 'opus', content: combined });

    // Flush Opus buffer so he writes a fresh synthesis
    if (this.callbacks) {
      this.flushOpusBuffer(this.callbacks);
    }
  }

  async stop() {
    logger.info('[ORCH] Shutting down...');

    // Capture agent session IDs before stopping
    const opusSid = this.opus.getSessionId();
    const claudeSid = this.claude.getSessionId();
    const codexSid = this.codex.getSessionId();
    if (opusSid) this.sessionManager?.setAgentSession('opus', opusSid);
    if (claudeSid) this.sessionManager?.setAgentSession('claude', claudeSid);
    if (codexSid) this.sessionManager?.setAgentSession('codex', codexSid);

    // Finalize session
    await this.sessionManager?.finalize();

    this.opusQueue.clear();
    this.claudeQueue.clear();
    this.codexQueue.clear();
    await Promise.allSettled([this.opus.stop(), this.claude.stop(), this.codex.stop()]);
    logger.info('[ORCH] Shutdown complete');
  }
}
