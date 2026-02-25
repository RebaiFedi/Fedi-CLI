import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { logger } from '../utils/logger.js';
import { formatAction } from '../utils/format-action.js';

export class ClaudeAgent implements AgentProcess {
  readonly id = 'claude' as const;
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
      logger.warn('[CLAUDE] Already running, stopping first');
      await this.stop();
    }

    this.cliPath = config.claudePath;

    const args = [
      '-p',
      '--model', 'claude-sonnet-4-6',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    logger.info(`[CLAUDE] Spawning: ${this.cliPath} ${args.join(' ')}`);

    this.process = spawn(this.cliPath, args, {
      cwd: config.projectDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setStatus('running');

    // Read stdout line-by-line (stream-json outputs JSONL)
    const rl = createInterface({ input: this.process.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        this.handleStreamMessage(parsed);
      } catch {
        // Non-JSON verbose output
        this.emit({ text: line, timestamp: Date.now(), type: 'stdout' });
      }
    });

    // Stderr for verbose logs
    const stderrRl = createInterface({ input: this.process.stderr! });
    stderrRl.on('line', (line) => {
      if (!line.trim()) return;
      logger.debug(`[CLAUDE stderr] ${line}`);
    });

    this.process.on('exit', (code) => {
      logger.info(`[CLAUDE] Process exited with code ${code}`);
      this.setStatus('stopped');
      this.process = null;
    });

    this.process.on('error', (err) => {
      logger.error(`[CLAUDE] Process error: ${err.message}`);
      this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
      this.setStatus('error');
    });

    // Send initial prompt with system prompt
    this.sendRaw({
      type: 'user',
      message: {
        role: 'user',
        content: `${systemPrompt}\n\nNow begin working on the task.`,
      },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
  }

  private handleStreamMessage(msg: Record<string, unknown>) {
    const type = msg.type as string;
    logger.debug(`[CLAUDE event] ${type} ${msg.subtype ?? ''}`);

    if (type === 'system' && msg.session_id) {
      this.sessionId = msg.session_id as string;
      logger.info(`[CLAUDE] Session ID: ${this.sessionId}`);
    }

    if (type === 'assistant' && msg.message) {
      const message = msg.message as { content: Array<Record<string, unknown>> };
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          // Text output
          if (block.type === 'text' && block.text) {
            this.emit({ text: block.text as string, timestamp: Date.now(), type: 'stdout' });
          }
          // Tool use — show what Claude is doing
          if (block.type === 'tool_use') {
            const toolName = block.name as string ?? 'tool';
            const input = block.input as Record<string, unknown> | undefined;
            this.emitToolAction(toolName, input);
          }
        }
      }
    }

    // Tool results
    if (type === 'assistant' && msg.tool_results) {
      // Handled silently — the output is in the assistant text
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
      logger.error('[CLAUDE] Cannot send: process not running');
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
    logger.debug(`[CLAUDE] Sending: ${json.slice(0, 200)}`);
    this.process.stdin.write(json + '\n');
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    logger.info('[CLAUDE] Stopping...');
    this.process.stdin?.end();
    this.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          logger.warn('[CLAUDE] Force killing after 3s');
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
