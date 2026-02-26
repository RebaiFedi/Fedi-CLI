import PQueue from 'p-queue';
import { ClaudeAgent } from '../agents/claude.js';
import { CodexAgent } from '../agents/codex.js';
import { OpusAgent } from '../agents/opus.js';
import type { AgentId, AgentStatus, Message, OutputLine, SessionConfig } from '../agents/types.js';
import { TO_CLAUDE_PATTERN, TO_CODEX_PATTERN, TO_OPUS_PATTERN } from '../agents/types.js';
import { MessageBus } from './message-bus.js';
import { getClaudeSystemPrompt, getCodexSystemPrompt, getOpusSystemPrompt, getCodexContextReminder } from './prompts.js';
import { logger } from '../utils/logger.js';
import { SessionManager } from '../utils/session-manager.js';

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
  private agentLastContextIndex: Map<AgentId, number> = new Map([
    ['opus', 0], ['claude', 0], ['codex', 0],
  ]);
  private sessionManager: SessionManager | null = null;
  /** Agents currently working on a relay from Opus — text output muted, actions only */
  private agentsOnRelay: Set<AgentId> = new Set();
  /** Buffer stdout while agent works on relay — flushed when relay ends */
  private relayBuffer: Map<AgentId, OutputLine[]> = new Map([
    ['claude', []], ['codex', []], ['opus', []],
  ]);
  /** Timestamp when relay started for each agent — used for safety timeout */
  private relayStartTime: Map<AgentId, number> = new Map();

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

    // Opus output & status — buffer when delegates are working
    this.opus.onOutput((line) => {
      // Relay detection runs ALWAYS (even when buffered) to detect [TO:*]
      this.detectRelayPatterns('opus', line.text);

      // If Opus delegated and is waiting for reports → buffer output
      if (this.agentsOnRelay.size > 0 && this.isOpusWaitingForRelays()) {
        const start = Math.min(...[...this.relayStartTime.values()]);
        if (Date.now() - start > 120_000) {
          // Timeout 120s — flush everything and let output through
          logger.warn('[ORCH] Opus relay-wait timeout (120s) — flushing buffer');
          this.flushOpusBuffer(cb);
        } else {
          this.relayBuffer.get('opus')!.push(line);
          return; // Don't display
        }
      }
      cb.onAgentOutput('opus', line);
    });
    this.opus.onStatusChange((s) => cb.onAgentStatus('opus', s));

    // Claude output & status — buffer text when working on relay, flush when done
    this.claude.onOutput((line) => {
      if (this.agentsOnRelay.has('claude') && line.type === 'stdout') {
        const start = this.relayStartTime.get('claude') ?? 0;
        if (Date.now() - start > 120_000) {
          // Relay timeout — unmute and let output through
          this.agentsOnRelay.delete('claude');
          this.relayBuffer.set('claude', []);
          this.relayStartTime.delete('claude');
          logger.warn('[ORCH] Claude relay timeout (120s) — unmuting');
        } else {
          // Buffer instead of drop — relay detection still runs
          this.detectRelayPatterns('claude', line.text);
          this.relayBuffer.get('claude')!.push(line);
          return;
        }
      }
      cb.onAgentOutput('claude', line);
      this.detectRelayPatterns('claude', line.text);
    });
    this.claude.onStatusChange((s) => {
      if (s === 'stopped' || s === 'error') {
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

    // Codex output & status — buffer text when working on relay, flush when done
    this.codex.onOutput((line) => {
      if (this.agentsOnRelay.has('codex') && line.type === 'stdout') {
        const start = this.relayStartTime.get('codex') ?? 0;
        if (Date.now() - start > 120_000) {
          // Relay timeout — unmute and let output through
          this.agentsOnRelay.delete('codex');
          this.relayBuffer.set('codex', []);
          this.relayStartTime.delete('codex');
          logger.warn('[ORCH] Codex relay timeout (120s) — unmuting');
        } else {
          this.detectRelayPatterns('codex', line.text);
          this.relayBuffer.get('codex')!.push(line);
          return;
        }
      }
      cb.onAgentOutput('codex', line);
      this.detectRelayPatterns('codex', line.text);
    });
    this.codex.onStatusChange((s) => {
      if (s === 'stopped' || s === 'error') {
        this.agentsOnRelay.delete('codex');
        this.relayBuffer.set('codex', []);
        this.relayStartTime.delete('codex');
        // If no more active delegates → flush Opus buffer
        if (!this.isOpusWaitingForRelays() && this.callbacks) {
          this.flushOpusBuffer(this.callbacks);
        }
      }
      // Safety net: Codex proc.exit → si encore en relay, auto-relay le buffer
      if (s === 'waiting' && this.agentsOnRelay.has('codex')) {
        const buffer = this.relayBuffer.get('codex') ?? [];
        const textLines = buffer
          .filter(l => l.type === 'stdout')
          .map(l => l.text)
          .join('\n')
          .trim();
        if (textLines) {
          logger.info(`[ORCH] Codex finished on relay without [TO:OPUS] — auto-relaying ${textLines.length} chars`);
          this.recordRelay();
          this.bus.relay('codex', 'opus', textLines);
        } else {
          logger.warn('[ORCH] Codex finished on relay — no buffered text to relay');
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

    this.bus.on('relay', (msg: Message) => cb.onRelay(msg));
    this.bus.on('relay-blocked', (msg: Message) => cb.onRelayBlocked(msg));

    // Route messages to Opus — inject cross-agent context
    this.bus.on('message:opus', (msg: Message) => {
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
      if (msg.from === 'claude') return;
      this.claudeQueue.add(async () => {
        await this.ensureClaudeStarted();
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
      if (msg.from === 'codex') return;
      this.codexQueue.add(async () => {
        await this.ensureCodexStarted();
        await this.codexReady; // Wait for start() to fully complete before sending
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
    this.sessionManager?.createSession(task, config.projectDir);

    // Listen for all bus messages → persist them
    this.bus.on('message', (msg: Message) => {
      this.sessionManager?.addMessage(msg);
    });

    // Only Opus starts immediately — Claude starts lazily when Opus delegates
    const opusPrompt = getOpusSystemPrompt(config.projectDir) + `\n\nMESSAGE DU USER: ${task}`;
    await this.opus.start({ ...config, task }, opusPrompt);

    logger.info('[ORCH] Opus started (Claude on standby)');

    // Start Codex eagerly in background (muted — no output until @codex or relay)
    this.ensureCodexStarted({ muted: true }).catch(err =>
      logger.error(`[ORCH] Codex eager start failed: ${err}`)
    );
  }

  get isStarted() { return this.started; }

  /** Restart after stop — reset state and start fresh with new task */
  async restart(task: string) {
    // Reset internal state
    this.started = false;
    this.claudeStarted = false;
    this.codexStarted = false;
    this.codexReady = Promise.resolve();
    this.agentLastContextIndex = new Map([
      ['opus', 0], ['claude', 0], ['codex', 0],
    ]);
    this.agentsOnRelay.clear();
    this.relayBuffer = new Map([
      ['claude', []], ['codex', []], ['opus', []],
    ]);
    this.relayStartTime.clear();

    // Start fresh
    await this.startWithTask(task);
  }

  sendUserMessage(text: string) {
    this.bus.send({ from: 'user', to: 'opus', content: text });
  }

  sendToAgent(agent: AgentId, text: string) {
    // User speaking directly to agent — clear relay mute and flush buffer
    this.agentsOnRelay.delete(agent);
    if (this.callbacks) {
      for (const buffered of this.relayBuffer.get(agent) ?? []) {
        this.callbacks.onAgentOutput(agent, buffered);
      }
    }
    this.relayBuffer.set(agent, []);
    this.bus.send({ from: 'user', to: agent, content: text });
  }

  sendToAll(text: string) {
    this.bus.send({ from: 'user', to: 'opus', content: text });
    this.bus.send({ from: 'user', to: 'claude', content: text });
    this.bus.send({ from: 'user', to: 'codex', content: text });
  }

  private isRelayRateLimited(): boolean {
    const now = Date.now();
    this.relayTimestamps = this.relayTimestamps.filter(t => now - t < RELAY_WINDOW_MS);
    return this.relayTimestamps.length >= MAX_RELAYS_PER_WINDOW;
  }

  private recordRelay() {
    this.relayTimestamps.push(Date.now());
  }

  private isRelayTag(line: string): boolean {
    return TO_CLAUDE_PATTERN.test(line) || TO_CODEX_PATTERN.test(line) || TO_OPUS_PATTERN.test(line);
  }

  private matchRelayTag(line: string, from: AgentId): { target: AgentId; firstLine: string } | null {
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
      if (!match) { i++; continue; }

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
        if (from === 'opus' && target !== 'opus') {
          this.agentsOnRelay.add(target);
          this.relayStartTime.set(target, Date.now());
        }
        this.recordRelay();
        this.bus.relay(from, target, content);
        // Agent reporting back to Opus → relay task is done, clear mute
        if (target === 'opus' && from !== 'opus') {
          this.agentsOnRelay.delete(from);
          this.relayBuffer.set(from, []);
          this.relayStartTime.delete(from);
          // If no more active delegates → flush Opus buffer
          if (!this.isOpusWaitingForRelays()) {
            logger.info('[ORCH] All delegates reported — flushing Opus buffer');
            if (this.callbacks) this.flushOpusBuffer(this.callbacks);
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

  /** Flush Opus buffered output to the UI */
  private flushOpusBuffer(cb: OrchestratorCallbacks) {
    const buffer = this.relayBuffer.get('opus') ?? [];
    for (const line of buffer) {
      cb.onAgentOutput('opus', line);
    }
    this.relayBuffer.set('opus', []);
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
    this.sessionManager?.finalize();

    this.opusQueue.clear();
    this.claudeQueue.clear();
    this.codexQueue.clear();
    await Promise.allSettled([this.opus.stop(), this.claude.stop(), this.codex.stop()]);
    logger.info('[ORCH] Shutdown complete');
  }
}
