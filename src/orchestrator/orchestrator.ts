import PQueue from 'p-queue';
import { ClaudeAgent } from '../agents/claude.js';
import { CodexAgent } from '../agents/codex.js';
import { HaikuAgent } from '../agents/haiku.js';
import type { AgentId, AgentStatus, Message, OutputLine, SessionConfig } from '../agents/types.js';
import { TO_CLAUDE_PATTERN, TO_CODEX_PATTERN, TO_HAIKU_PATTERN } from '../agents/types.js';
import { MessageBus } from './message-bus.js';
import { getClaudeSystemPrompt, getCodexSystemPrompt, getHaikuSystemPrompt } from './prompts.js';
import { logger } from '../utils/logger.js';

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
  readonly haiku = new HaikuAgent();
  readonly claude = new ClaudeAgent();
  readonly codex = new CodexAgent();
  readonly bus = new MessageBus();
  private haikuQueue = new PQueue({ concurrency: 1 });
  private claudeQueue = new PQueue({ concurrency: 1 });
  private codexQueue = new PQueue({ concurrency: 1 });
  private callbacks: OrchestratorCallbacks | null = null;
  private started = false;
  private claudeStarted = false;
  private codexStarted = false;
  private config: Omit<SessionConfig, 'task'> | null = null;
  private relayTimestamps: number[] = [];

  setConfig(config: Omit<SessionConfig, 'task'>) {
    this.config = config;
  }

  bind(cb: OrchestratorCallbacks) {
    this.callbacks = cb;

    // Haiku output & status
    this.haiku.onOutput((line) => {
      cb.onAgentOutput('haiku', line);
      this.detectRelayPatterns('haiku', line.text);
    });
    this.haiku.onStatusChange((s) => cb.onAgentStatus('haiku', s));

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

    // Route messages to Haiku
    this.bus.on('message:haiku', (msg: Message) => {
      if (msg.from === 'haiku') return;
      this.haikuQueue.add(() => {
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        this.haiku.send(`${prefix} ${msg.content}`);
        return Promise.resolve();
      });
    });

    // Route messages to Claude (lazy start)
    this.bus.on('message:claude', (msg: Message) => {
      if (msg.from === 'claude') return;
      this.claudeQueue.add(async () => {
        await this.ensureClaudeStarted();
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        this.claude.send(`${prefix} ${msg.content}`);
      });
    });

    // Route messages to Codex (lazy start)
    this.bus.on('message:codex', (msg: Message) => {
      if (msg.from === 'codex') return;
      this.codexQueue.add(async () => {
        await this.ensureCodexStarted();
        const prefix = `[FROM:${msg.from.toUpperCase()}]`;
        this.codex.send(`${prefix} ${msg.content}`);
      });
    });
  }

  /** Start Claude on first message to it */
  private async ensureClaudeStarted() {
    if (this.claudeStarted || !this.config) return;
    this.claudeStarted = true;
    const config = this.config;
    logger.info('[ORCH] Lazy-starting Claude...');
    const prompt = getClaudeSystemPrompt(config.projectDir);
    await this.claude.start({ ...config, task: '' }, prompt);
  }

  /** Start Codex on first message to it */
  private async ensureCodexStarted() {
    if (this.codexStarted || !this.config) return;
    this.codexStarted = true;
    const config = this.config;
    logger.info('[ORCH] Lazy-starting Codex...');
    const prompt = getCodexSystemPrompt(config.projectDir);
    await this.codex.start({ ...config, task: '' }, prompt);
  }

  /** Start with first user message. Only Haiku starts immediately. */
  async startWithTask(task: string) {
    if (this.started || !this.config) return;
    this.started = true;

    const config = this.config;
    logger.info(`[ORCH] Starting Haiku with task: ${task.slice(0, 80)}`);

    // Only Haiku starts — Claude & Codex start lazily when Haiku delegates
    const haikuPrompt = getHaikuSystemPrompt(config.projectDir) + `\n\nMESSAGE DU USER: ${task}`;
    await this.haiku.start({ ...config, task }, haikuPrompt);

    logger.info('[ORCH] Haiku started (Claude & Codex on standby)');
  }

  get isStarted() { return this.started; }

  sendUserMessage(text: string) {
    this.bus.send({ from: 'user', to: 'haiku', content: text });
  }

  sendToAgent(agent: AgentId, text: string) {
    this.bus.send({ from: 'user', to: agent, content: text });
  }

  sendToAll(text: string) {
    this.bus.send({ from: 'user', to: 'haiku', content: text });
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

      const toHaikuMatch = line.match(TO_HAIKU_PATTERN);
      if (toHaikuMatch && from !== 'haiku') {
        const content = toHaikuMatch[1].trim();
        if (content) {
          logger.info(`[ORCH] Relay: ${from} → haiku: ${content.slice(0, 80)}`);
          this.recordRelay();
          this.bus.relay(from, 'haiku', content);
        }
      }

      if (this.isRelayRateLimited()) break;
    }
  }

  async stop() {
    logger.info('[ORCH] Shutting down...');
    this.haikuQueue.clear();
    this.claudeQueue.clear();
    this.codexQueue.clear();
    await Promise.allSettled([this.haiku.stop(), this.claude.stop(), this.codex.stop()]);
    logger.info('[ORCH] Shutdown complete');
  }
}
