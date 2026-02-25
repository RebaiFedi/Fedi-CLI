import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { logger } from '../utils/logger.js';
import { formatAction } from '../utils/format-action.js';

export class HaikuAgent implements AgentProcess {
  readonly id = 'haiku' as const;
  status: AgentStatus = 'idle';
  private process: ChildProcess | null = null;
  private sessionId: string | null = null;
  private cliPath: string = 'claude';
  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];

  private setStatus(s: AgentStatus) {
    this.status = s;
    this.statusHandlers.forEach(h => h(s));
  }

  private emit(line: OutputLine) {
    this.outputHandlers.forEach(h => h(line));
  }

  onOutput(handler: (line: OutputLine) => void) {
    this.outputHandlers.push(handler);
  }

  onStatusChange(handler: (status: AgentStatus) => void) {
    this.statusHandlers.push(handler);
  }

  async start(config: SessionConfig, systemPrompt: string): Promise<void> {
    if (this.process) {
      logger.warn('[HAIKU] Already running, stopping first');
      await this.stop();
    }

    this.cliPath = config.claudePath;

    const args = [
      '-p',
      '--model', 'claude-opus-4-6',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    logger.info(`[HAIKU] Spawning: ${this.cliPath} ${args.join(' ')}`);

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
      logger.debug(`[HAIKU stderr] ${line}`);
    });

    this.process.on('exit', (code) => {
      logger.info(`[HAIKU] Process exited with code ${code}`);
      this.setStatus('stopped');
      this.process = null;
    });

    this.process.on('error', (err) => {
      logger.error(`[HAIKU] Process error: ${err.message}`);
      this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
      this.setStatus('error');
    });

    this.sendRaw({
      type: 'user',
      message: {
        role: 'user',
        content: systemPrompt,
      },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
  }

  private handleStreamMessage(msg: Record<string, unknown>) {
    const type = msg.type as string;
    const subtype = msg.subtype as string | undefined;
    logger.debug(`[HAIKU event] ${type} ${subtype ?? ''}`);

    if (type === 'system' && msg.session_id) {
      this.sessionId = msg.session_id as string;
      logger.info(`[HAIKU] Session ID: ${this.sessionId}`);
    }

    // Detect context compaction
    if (type === 'system' && subtype === 'conversation_compacted') {
      logger.warn('[HAIKU] Context window compacted');
      this.emit({ text: 'Opus: contexte compacte (auto-compact)', timestamp: Date.now(), type: 'info' });
    }

    // Detect errors (context limit, etc.)
    if (type === 'result' && msg.is_error) {
      const errorMsg = (msg.result as string) || 'Unknown error';
      logger.error(`[HAIKU] Result error: ${errorMsg}`);
      this.emit({ text: `Opus error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
    }

    if (type === 'assistant' && msg.message) {
      const message = msg.message as { content: Array<Record<string, unknown>> };
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            this.emit({ text: block.text as string, timestamp: Date.now(), type: 'stdout' });
          }
          if (block.type === 'tool_use') {
            const toolName = block.name as string ?? 'tool';
            const input = block.input as Record<string, unknown> | undefined;
            this.emitToolAction(toolName, input);
          }
        }
      }
    }

    if (type === 'result') {
      this.setStatus('waiting');
    }
  }

  private emitToolAction(toolName: string, input?: Record<string, unknown>) {
    let detail: string | undefined;
    switch (toolName) {
      case 'Read': detail = input?.file_path as string; break;
      case 'Write': detail = input?.file_path as string; break;
      case 'Edit': detail = input?.file_path as string; break;
      case 'Bash': detail = input?.command as string; break;
      case 'Glob': detail = input?.pattern as string; break;
      case 'Grep': detail = input?.pattern as string; break;
      default: detail = undefined;
    }
    const formatted = formatAction(toolName, detail);
    if (formatted) {
      this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
    }
  }

  send(prompt: string) {
    if (!this.process?.stdin?.writable) {
      logger.error('[HAIKU] Cannot send: process not running');
      return;
    }
    this.setStatus('running');
    this.sendRaw({
      type: 'user',
      message: {
        role: 'user',
        content: prompt,
      },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
  }

  private sendRaw(obj: Record<string, unknown>) {
    if (!this.process?.stdin?.writable) return;
    const json = JSON.stringify(obj);
    logger.debug(`[HAIKU] Sending: ${json.slice(0, 200)}`);
    this.process.stdin.write(json + '\n');
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    logger.info('[HAIKU] Stopping...');
    this.process.stdin?.end();
    this.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          logger.warn('[HAIKU] Force killing after 3s');
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
