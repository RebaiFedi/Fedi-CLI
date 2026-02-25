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
  private config: Omit<SessionConfig, 'task'> | null = null;
  private relayTimestamps: number[] = [];
  private agentLastContextIndex: Map<AgentId, number> = new Map([
    ['opus', 0], ['claude', 0], ['codex', 0],
  ]);
  private sessionManager: SessionManager | null = null;

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

    // Opus output & status
    this.opus.onOutput((line) => {
      cb.onAgentOutput('opus', line);
      this.detectRelayPatterns('opus', line.text);
    });
    this.opus.onStatusChange((s) => cb.onAgentStatus('opus', s));

    // Claude output & status
    this.claude.onOutput((line) => {
      cb.onAgentOutput('claude', line);
      this.detectRelayPatterns('claude', line.text);
    });
    this.claude.onStatusChange((s) => cb.onAgentStatus('claude', s));

    // Codex output & status
    this.codex.onOutput((line) => {
      cb.onAgentOutput('codex', line);
      this.detectRelayPatterns('codex', line.text);
    });
    this.codex.onStatusChange((s) => cb.onAgentStatus('codex', s));

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
  private async ensureCodexStarted() {
    if (this.codexStarted || !this.config) return;
    this.codexStarted = true;
    const config = this.config;
    logger.info('[ORCH] Lazy-starting Codex...');
    let prompt = getCodexSystemPrompt(config.projectDir);
    // Inject recent history so Codex knows why it's being called
    const { summary, newIndex } = this.bus.getContextSummary('codex', 0, 5);
    this.agentLastContextIndex.set('codex', newIndex);
    if (summary) {
      prompt += `\n\n--- HISTORIQUE ---\n${summary}\n--- FIN ---`;
    }
    // Set compact reminder for session loss recovery
    this.codex.setContextReminder(getCodexContextReminder(config.projectDir));
    await this.codex.start({ ...config, task: '' }, prompt);
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

    // Only Opus starts — Claude & Codex start lazily when Opus delegates
    const opusPrompt = getOpusSystemPrompt(config.projectDir) + `\n\nMESSAGE DU USER: ${task}`;
    await this.opus.start({ ...config, task }, opusPrompt);

    logger.info('[ORCH] Opus started (Claude & Codex on standby)');
  }

  get isStarted() { return this.started; }

  /** Restart after stop — reset state and start fresh with new task */
  async restart(task: string) {
    // Reset internal state
    this.started = false;
    this.claudeStarted = false;
    this.codexStarted = false;
    this.agentLastContextIndex = new Map([
      ['opus', 0], ['claude', 0], ['codex', 0],
    ]);

    // Start fresh
    await this.startWithTask(task);
  }

  sendUserMessage(text: string) {
    this.bus.send({ from: 'user', to: 'opus', content: text });
  }

  sendToAgent(agent: AgentId, text: string) {
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

  private detectRelayPatterns(from: AgentId, text: string) {
    if (this.isRelayRateLimited()) {
      logger.warn(`[ORCH] Relay rate limited — skipping from ${from}`);
      return;
    }

    for (const line of text.split('\n')) {
      const toClaudeMatch = line.match(TO_CLAUDE_PATTERN);
      if (toClaudeMatch && from !== 'claude') {
        const content = toClaudeMatch[1].trim();
        if (content) {
          logger.info(`[ORCH] Relay: ${from} → claude: ${content.slice(0, 80)}`);
          this.recordRelay();
          this.bus.relay(from, 'claude', content);
        }
      }

      const toCodexMatch = line.match(TO_CODEX_PATTERN);
      if (toCodexMatch && from !== 'codex') {
        const content = toCodexMatch[1].trim();
        if (content) {
          logger.info(`[ORCH] Relay: ${from} → codex: ${content.slice(0, 80)}`);
          this.recordRelay();
          this.bus.relay(from, 'codex', content);
        }
      }

      const toOpusMatch = line.match(TO_OPUS_PATTERN);
      if (toOpusMatch && from !== 'opus') {
        const content = toOpusMatch[1].trim();
        if (content) {
          logger.info(`[ORCH] Relay: ${from} → opus: ${content.slice(0, 80)}`);
          this.recordRelay();
          this.bus.relay(from, 'opus', content);
        }
      }

      if (this.isRelayRateLimited()) break;
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
    this.sessionManager?.finalize();

    this.opusQueue.clear();
    this.claudeQueue.clear();
    this.codexQueue.clear();
    await Promise.allSettled([this.opus.stop(), this.claude.stop(), this.codex.stop()]);
    logger.info('[ORCH] Shutdown complete');
  }
}
