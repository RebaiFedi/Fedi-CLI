import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentId, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { flog } from '../utils/log.js';
import { formatAction } from '../utils/format-action.js';
import { parseMessageWithImages, type ContentBlock } from '../utils/image-utils.js';

export abstract class BaseClaudeAgent implements AgentProcess {
  abstract readonly id: AgentId;
  status: AgentStatus = 'idle';
  protected process: ChildProcess | null = null;
  protected sessionId: string | null = null;
  protected cliPath: string = 'claude';
  protected outputHandlers: Array<(line: OutputLine) => void> = [];
  protected statusHandlers: Array<(status: AgentStatus) => void> = [];

  /** Human-readable agent name for log messages */
  protected abstract get logTag(): string;
  /** The model flag passed to the CLI */
  protected abstract get model(): string;
  /** Extra spawn args appended after model args. Receives systemPrompt for agents that need --system-prompt flag. */
  protected getExtraArgs(_systemPrompt: string): string[] {
    return [];
  }

  protected setStatus(s: AgentStatus) {
    this.status = s;
    this.statusHandlers.forEach((h) => h(s));
  }

  protected emit(line: OutputLine) {
    this.outputHandlers.forEach((h) => h(line));
  }

  onOutput(handler: (line: OutputLine) => void) {
    this.outputHandlers.push(handler);
  }

  onStatusChange(handler: (status: AgentStatus) => void) {
    this.statusHandlers.push(handler);
  }

  async start(config: SessionConfig, systemPrompt: string): Promise<void> {
    if (this.process) {
      flog.warn('AGENT', `${this.logTag}: Already running, stopping first`);
      await this.stop();
    }

    this.cliPath = config.claudePath;

    const args = [
      '-p',
      '--model',
      this.model,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    // Resume existing session if available (preserves conversation history)
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      flog.info('AGENT', `${this.logTag}: Resuming session ${this.sessionId}`);
    }

    args.push(...this.getExtraArgs(systemPrompt));

    flog.info('AGENT', `${this.logTag}: Spawning: ${this.cliPath} ${args.join(' ')}`);

    this.process = spawn(this.cliPath, args, {
      cwd: config.projectDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setStatus('running');

    const rl = createInterface({ input: this.process.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        this.handleStreamMessage(parsed);
      } catch {
        this.emit({ text: line, timestamp: Date.now(), type: 'stdout' });
      }
    });

    const stderrRl = createInterface({ input: this.process.stderr! });
    stderrRl.on('line', (line) => {
      if (!line.trim()) return;
      flog.debug('AGENT', `${this.logTag} stderr: ${line}`);
    });

    this.process.on('exit', (code) => {
      flog.info('AGENT', `${this.logTag}: Process exited with code ${code}`);
      this.setStatus('stopped');
      this.process = null;
    });

    this.process.on('error', (err) => {
      flog.error('AGENT', `${this.logTag}: Process error: ${err.message}`);
      this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
      this.setStatus('error');
    });

    // When resuming a session, the CLI already has the conversation history.
    // Don't re-send the system prompt — it would be redundant.
    if (!this.sessionId) {
      this.sendInitialMessage(systemPrompt);
    } else {
      flog.info('AGENT', `${this.logTag}: Skipping initial message (resumed session)`);
    }
  }

  /** Send the first message after spawn. Override to customize (e.g., mute response). */
  protected sendInitialMessage(systemPrompt: string) {
    const imageBlocks = parseMessageWithImages(systemPrompt);
    const content: string | ContentBlock[] = imageBlocks ?? systemPrompt;

    this.sendRaw({
      type: 'user',
      message: { role: 'user', content },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
  }

  protected handleStreamMessage(msg: Record<string, unknown>) {
    const type = msg.type as string;
    const subtype = msg.subtype as string | undefined;
    flog.debug('AGENT', `${this.logTag} event: ${type} ${subtype ?? ''}`);

    if (type === 'system' && msg.session_id) {
      this.sessionId = msg.session_id as string;
      flog.info('AGENT', `${this.logTag}: Session ID: ${this.sessionId}`);
    }

    if (type === 'system' && subtype === 'conversation_compacted') {
      flog.warn('AGENT', `${this.logTag}: Context window compacted`);
      this.emit({
        text: `${this.logTag}: contexte compacte (auto-compact)`,
        timestamp: Date.now(),
        type: 'info',
      });
    }

    if (type === 'result' && msg.is_error) {
      const errorMsg = (msg.result as string) || 'Unknown error';
      flog.error('AGENT', `${this.logTag}: Result error: ${errorMsg}`);
      this.emit({ text: `${this.logTag} error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
    }

    if (type === 'assistant' && msg.message) {
      if (this.status !== 'running') this.setStatus('running');
      const message = msg.message as { content: Array<Record<string, unknown>> };
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            this.emit({ text: block.text as string, timestamp: Date.now(), type: 'stdout' });
          }
          if (block.type === 'tool_use') {
            const toolName = (block.name as string) ?? 'tool';
            const input = block.input as Record<string, unknown> | undefined;
            this.emitToolAction(toolName, input);
          }
        }
      }
    }

    if (type === 'result') {
      this.onResult();
    }
  }

  /** Called when a 'result' event is received. Override to add behavior (e.g., unmute). */
  protected onResult() {
    this.setStatus('waiting');
  }

  protected emitToolAction(toolName: string, input?: Record<string, unknown>) {
    let detail: string | undefined;
    switch (toolName) {
      case 'Read':
        detail = input?.file_path as string;
        break;
      case 'Write':
        detail = input?.file_path as string;
        break;
      case 'Edit':
        detail = input?.file_path as string;
        break;
      case 'Bash':
        detail = input?.command as string;
        break;
      case 'Glob':
        detail = input?.pattern as string;
        break;
      case 'Grep':
        detail = input?.pattern as string;
        break;
      default:
        detail = undefined;
    }
    const formatted = formatAction(toolName, detail);
    if (formatted) {
      this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
    }
  }

  send(prompt: string) {
    if (!this.process?.stdin?.writable) {
      flog.error('AGENT', `${this.logTag}: Cannot send: process not running`);
      return;
    }
    this.setStatus('running');

    const imageBlocks = parseMessageWithImages(prompt);
    const content: string | ContentBlock[] = imageBlocks ?? prompt;

    this.sendRaw({
      type: 'user',
      message: { role: 'user', content },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
  }

  /** Inject a message directly into stdin WITHOUT changing agent status.
   *  Used for LIVE user messages and cross-talk while the agent is already running. */
  sendUrgent(prompt: string) {
    if (!this.process?.stdin?.writable) return;
    const imageBlocks = parseMessageWithImages(prompt);
    const content: string | ContentBlock[] = imageBlocks ?? prompt;
    this.sendRaw({
      type: 'user',
      message: { role: 'user', content },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
  }

  protected sendRaw(obj: Record<string, unknown>) {
    if (!this.process?.stdin?.writable) return;
    const json = JSON.stringify(obj);
    flog.debug('AGENT', `${this.logTag}: Sending: ${json.slice(0, 200)}`);
    this.process.stdin.write(json + '\n');
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    flog.info('AGENT', `${this.logTag}: Stopping...`);
    this.process.stdin?.end();
    this.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          flog.warn('AGENT', `${this.logTag}: Force killing after 3s`);
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 3000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this.setStatus('stopped');
  }
}
