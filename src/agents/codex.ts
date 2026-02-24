import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { logger } from '../utils/logger.js';
import { formatAction } from '../utils/format-action.js';

export class CodexAgent implements AgentProcess {
  readonly id = 'codex' as const;
  status: AgentStatus = 'idle';
  private sessionId: string | null = null;
  private projectDir: string = '';
  private cliPath: string = 'codex';
  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];
  private activeProcess: ReturnType<typeof spawn> | null = null;

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
    this.projectDir = config.projectDir;
    this.cliPath = config.codexPath;

    this.setStatus('running');

    const fullPrompt = `${systemPrompt}\n\nNow begin working on the task.`;
    await this.exec(fullPrompt);
  }

  send(prompt: string) {
    this.setStatus('running');
    this.exec(prompt).catch((err) => {
      logger.error(`[CODEX] exec error: ${err}`);
      this.setStatus('error');
    });
  }

  private async exec(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['exec'];

      if (this.sessionId) {
        args.push('resume', this.sessionId);
      }

      args.push(
        '--model', 'gpt-5.3-codex',
        '-c', 'model_reasoning_effort="xhigh"',
        '-c', 'model_reasoning_summary_effort="auto"',
        '--full-auto',
        '--json',
      );

      // Add skip-git-repo-check for non-git directories
      args.push('--skip-git-repo-check');

      args.push(prompt);

      logger.info(`[CODEX] Spawning: ${this.cliPath} ${args.slice(0, 3).join(' ')}... (prompt: ${prompt.slice(0, 80)})`);

      const proc = spawn(this.cliPath, args, {
        cwd: this.projectDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcess = proc;
      let fullStdout = '';

      // Parse streaming JSON events line by line
      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        fullStdout += line + '\n';
        try {
          const event = JSON.parse(line);
          this.handleStreamEvent(event);
        } catch {
          // Non-JSON output, show as-is
          this.emit({ text: line, timestamp: Date.now(), type: 'stdout' });
        }
      });

      const stderrRl = createInterface({ input: proc.stderr! });
      stderrRl.on('line', (line) => {
        if (!line.trim()) return;
        logger.debug(`[CODEX stderr] ${line}`);
      });

      proc.on('error', (err) => {
        logger.error(`[CODEX] Process error: ${err.message}`);
        this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
        this.setStatus('error');
        this.activeProcess = null;
        reject(err);
      });

      proc.on('exit', (code) => {
        logger.info(`[CODEX] Process exited with code ${code}`);
        this.activeProcess = null;
        this.setStatus('waiting');
        resolve(fullStdout);
      });
    });
  }

  private handleStreamEvent(event: Record<string, unknown>) {
    const eventType = event.type as string | undefined;
    logger.debug(`[CODEX event] ${eventType}`);

    // Extract thread/session ID
    if (eventType === 'thread.started' && event.thread_id) {
      this.sessionId = event.thread_id as string;
      logger.info(`[CODEX] Thread ID: ${this.sessionId}`);
    }

    // item.completed — the main payload with text content
    if (eventType === 'item.completed' && event.item) {
      const item = event.item as Record<string, unknown>;
      const itemType = item.type as string | undefined;

      // Agent message text (reasoning or final text)
      if (itemType === 'agent_message' || itemType === 'reasoning') {
        const text = item.text as string | undefined;
        if (text) {
          this.emit({ text, timestamp: Date.now(), type: 'stdout' });
          return;
        }
      }

      // File change events
      if (itemType === 'file_change') {
        const filename = item.filename as string | undefined;
        if (filename) {
          const formatted = formatAction('file_change', filename);
          if (formatted) this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
          return;
        }
      }

      // Command execution
      if (itemType === 'command_execution') {
        const command = item.command as string | undefined;
        if (command) {
          const formatted = formatAction('bash', command);
          if (formatted) this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
          return;
        }
      }

      // Generic: try to extract text from content array
      if (Array.isArray(item.content)) {
        for (const block of item.content as Array<Record<string, unknown>>) {
          if (block.text && typeof block.text === 'string') {
            this.emit({ text: block.text, timestamp: Date.now(), type: 'stdout' });
          } else if (block.type === 'output_text' && typeof block.text === 'string') {
            this.emit({ text: block.text, timestamp: Date.now(), type: 'stdout' });
          }
        }
        return;
      }
    }

    // item.started — skip (we show on completed to avoid duplicates)
    if (eventType === 'item.started') {
      return;
    }

    // turn.completed — usage info, mark waiting
    if (eventType === 'turn.completed') {
      this.setStatus('waiting');
    }
  }

  async stop(): Promise<void> {
    if (this.activeProcess) {
      logger.info('[CODEX] Stopping active process...');
      this.activeProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.activeProcess?.kill('SIGKILL');
          resolve();
        }, 3000);
        this.activeProcess!.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.activeProcess = null;
    }
    this.setStatus('stopped');
  }
}
