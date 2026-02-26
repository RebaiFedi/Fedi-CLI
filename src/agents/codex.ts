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
  private systemPromptSent = false;
  private contextReminder: string = '';
  private muted = false;
  private execLock: Promise<string> | null = null;

  private setStatus(s: AgentStatus) {
    this.status = s;
    if (this.muted) return;
    this.statusHandlers.forEach(h => h(s));
  }

  private emit(line: OutputLine) {
    if (this.muted) return;
    this.outputHandlers.forEach(h => h(line));
  }

  onOutput(handler: (line: OutputLine) => void) {
    this.outputHandlers.push(handler);
  }

  onStatusChange(handler: (status: AgentStatus) => void) {
    this.statusHandlers.push(handler);
  }

  async start(config: SessionConfig, systemPrompt: string, options?: { muted?: boolean }): Promise<void> {
    this.projectDir = config.projectDir;
    this.cliPath = config.codexPath;

    this.muted = options?.muted ?? false;
    this.setStatus('running');

    const suffix = options?.muted
      ? '\n\nTu es en standby. Reponds UNIQUEMENT: "Pret." — rien d\'autre. N\'execute AUCUNE commande, ne lis AUCUN fichier. Attends qu\'on te donne une tache.'
      : '\n\nNow begin working on the task.';
    await this.exec(`${systemPrompt}${suffix}`);
    this.systemPromptSent = true;
    this.muted = false;
  }

  setContextReminder(reminder: string) {
    this.contextReminder = reminder;
  }

  send(prompt: string) {
    this.muted = false;
    this.setStatus('running');
    // If session was lost (no threadId) but system prompt was already sent,
    // prepend a compact reminder instead of the full 600-token prompt
    let finalPrompt = prompt;
    if (!this.sessionId && this.systemPromptSent && this.contextReminder) {
      finalPrompt = `${this.contextReminder}\n\n${prompt}`;
      logger.info('[CODEX] Session lost — prepending compact context reminder');
    }
    this.exec(finalPrompt).catch((err) => {
      logger.error(`[CODEX] exec error: ${err}`);
      this.setStatus('error');
    });
  }

  private async exec(prompt: string): Promise<string> {
    // Serialize exec calls — wait for any in-flight exec to finish first
    if (this.execLock) {
      await this.execLock;
    }

    const promise = this._doExec(prompt);
    this.execLock = promise;
    try {
      return await promise;
    } finally {
      if (this.execLock === promise) this.execLock = null;
    }
  }

  private async _doExec(prompt: string): Promise<string> {
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
          // Filter out Codex CLI banner/noise lines
          if (this.isNoiseLine(line)) {
            logger.debug(`[CODEX] Filtered noise: ${line.slice(0, 80)}`);
            return;
          }
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

    // Detect context/thread errors
    if (eventType === 'error') {
      const errorMsg = (event.message as string) || (event.error as string) || 'Unknown error';
      logger.error(`[CODEX] Error event: ${errorMsg}`);
      this.emit({ text: `Codex error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
    }

    // Detect thread truncation / context limit
    if (eventType === 'thread.truncated' || eventType === 'context_limit_exceeded') {
      logger.warn(`[CODEX] Context limit: ${eventType}`);
      this.emit({ text: 'Codex: contexte tronque (limite atteinte)', timestamp: Date.now(), type: 'info' });
    }

    // item.completed — the main payload with text content
    if (eventType === 'item.completed' && event.item) {
      const item = event.item as Record<string, unknown>;
      const itemType = item.type as string | undefined;
      const itemStatus = item.status as string | undefined;

      // Reasoning summary — log only, don't display
      if (itemType === 'reasoning') {
        const text = item.text as string | undefined;
        if (text) logger.debug(`[CODEX reasoning] ${text.slice(0, 120)}`);
        return;
      }

      // Agent message text (final response)
      if (itemType === 'agent_message') {
        const text = item.text as string | undefined;
        if (text) {
          this.emit({ text, timestamp: Date.now(), type: 'stdout' });
          return;
        }
      }

      // OpenAI Responses API "message" type — final agent output
      if (itemType === 'message' || itemType === 'output_message') {
        let text: string | undefined;
        if (Array.isArray(item.content)) {
          const texts: string[] = [];
          for (const block of item.content as Array<Record<string, unknown>>) {
            if (typeof block.text === 'string') texts.push(block.text);
          }
          if (texts.length > 0) text = texts.join('\n');
        }
        if (!text && Array.isArray(item.output)) {
          const texts: string[] = [];
          for (const block of item.output as Array<Record<string, unknown>>) {
            if (typeof block.text === 'string') texts.push(block.text);
          }
          if (texts.length > 0) text = texts.join('\n');
        }
        if (!text && typeof item.text === 'string') text = item.text as string;
        if (text) {
          this.emit({ text, timestamp: Date.now(), type: 'stdout' });
          return;
        }
      }

      // File change events — show action + status
      if (itemType === 'file_change') {
        const filename = item.filename as string | undefined;
        const action = item.action as string | undefined;
        if (filename) {
          const label = action === 'create' ? 'create' : action === 'delete' ? 'delete' : 'write';
          const formatted = formatAction(label, filename);
          if (formatted) {
            const suffix = itemStatus && itemStatus !== 'completed' ? ` (${itemStatus})` : '';
            this.emit({ text: `${formatted}${suffix}`, timestamp: Date.now(), type: 'system' });
          }
          return;
        }
      }

      // Command execution — show command + exit code
      if (itemType === 'command_execution') {
        const command = item.command as string | undefined;
        const exitCode = item.exit_code as number | undefined;
        if (command) {
          const formatted = formatAction('bash', command);
          if (formatted) {
            const suffix = exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode})` : '';
            this.emit({ text: `${formatted}${suffix}`, timestamp: Date.now(), type: 'system' });
          }
          // Show stderr output if command failed
          if (exitCode !== undefined && exitCode !== 0) {
            const stderr = item.stderr as string | undefined;
            if (stderr) {
              const short = stderr.length > 200 ? stderr.slice(0, 200) + '...' : stderr;
              this.emit({ text: short, timestamp: Date.now(), type: 'info' });
            }
          }
          return;
        }
      }

      // File read events
      if (itemType === 'file_read' || itemType === 'read_file') {
        const filename = (item.filename || item.path) as string | undefined;
        if (filename) {
          const formatted = formatAction('read', filename);
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

      // Catch-all: unknown item type with text content
      logger.info(`[CODEX] Unhandled item.completed type="${itemType}" — attempting text extraction`);
      if (typeof item.text === 'string' && (item.text as string).trim()) {
        this.emit({ text: item.text as string, timestamp: Date.now(), type: 'stdout' });
        return;
      }
      if (Array.isArray(item.output)) {
        for (const block of item.output as Array<Record<string, unknown>>) {
          if (typeof block.text === 'string' && block.text.trim()) {
            this.emit({ text: block.text, timestamp: Date.now(), type: 'stdout' });
          }
        }
        return;
      }
      if (typeof item.output === 'string' && (item.output as string).trim()) {
        this.emit({ text: item.output as string, timestamp: Date.now(), type: 'stdout' });
        return;
      }
      logger.warn(`[CODEX] item.completed type="${itemType}" — no text extracted. Keys: ${Object.keys(item).join(', ')}`);
    }

    // item.started — skip (we show on completed to avoid duplicates)
    if (eventType === 'item.started') {
      return;
    }

    // turn.completed — extract usage info, mark waiting
    if (eventType === 'turn.completed') {
      // Extract token usage if available
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        const input = usage.input_tokens as number | undefined;
        const output = usage.output_tokens as number | undefined;
        if (input || output) {
          logger.info(`[CODEX] Usage: ${input ?? '?'} in / ${output ?? '?'} out tokens`);
        }
      }
      this.setStatus('waiting');
    }
  }

  /** Filter Codex CLI banner and noise lines that aren't actual agent output */
  private isNoiseLine(line: string): boolean {
    const trimmed = line.trim();
    // Codex CLI banner: ">_ OpenAI Codex (v0.104.0)"
    if (/^>_\s*OpenAI\s+Codex/i.test(trimmed)) return true;
    // Directory line: "directory: /path/..."
    if (/^directory:\s+/i.test(trimmed)) return true;
    // Model info lines
    if (/^model:\s+/i.test(trimmed)) return true;
    // Provider lines
    if (/^provider:\s+/i.test(trimmed)) return true;
    // Separator lines (only dashes/boxes)
    if (/^[─━┌┐└┘├┤┬┴┼│\-=+]+$/.test(trimmed)) return true;
    // Approval mode lines
    if (/^approval mode:/i.test(trimmed)) return true;
    return false;
  }

  getSessionId(): string | null {
    return this.sessionId;
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
