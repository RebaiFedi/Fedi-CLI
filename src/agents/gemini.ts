import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { flog } from '../utils/log.js';
import { formatAction } from '../utils/format-action.js';

export class GeminiAgent implements AgentProcess {
  readonly id = 'gemini' as const;
  status: AgentStatus = 'idle';
  private sessionId: string | null = null;
  private projectDir: string = '';
  private cliPath: string = 'gemini';
  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private systemPromptSent = false;
  private contextReminder: string = '';
  private muted = false;
  private execLock: Promise<string> | null = null;
  /** Queued urgent messages — drained at the start of the next send() call */
  private urgentQueue: string[] = [];

  private setStatus(s: AgentStatus) {
    this.status = s;
    // When muted, still notify on terminal states so the spinner clears
    if (this.muted && s !== 'waiting' && s !== 'stopped' && s !== 'error') return;
    this.statusHandlers.forEach((h) => h(s));
  }

  private emit(line: OutputLine) {
    if (this.muted) return;
    this.outputHandlers.forEach((h) => h(line));
  }

  onOutput(handler: (line: OutputLine) => void) {
    this.outputHandlers.push(handler);
  }

  onStatusChange(handler: (status: AgentStatus) => void) {
    this.statusHandlers.push(handler);
  }

  async start(
    config: SessionConfig,
    systemPrompt: string,
    options?: { muted?: boolean },
  ): Promise<void> {
    this.projectDir = config.projectDir;
    this.cliPath = config.geminiPath || 'gemini';

    this.muted = options?.muted ?? false;
    this.setStatus('running');

    if (this.sessionId) {
      const resumeMsg = options?.muted
        ? '[Session reprise] Tu es en standby. Attends une tache.'
        : '[Session reprise] Continue ton travail.';
      flog.info('AGENT', `Gemini: Resuming session ${this.sessionId}`);
      await this.exec(resumeMsg);
    } else {
      const suffix = options?.muted
        ? "\n\nTu es en standby. Reponds UNIQUEMENT: \"Pret.\" — rien d'autre. N'execute AUCUNE commande, ne lis AUCUN fichier. Attends qu'on te donne une tache."
        : '\n\nNow begin working on the task.';
      await this.exec(`${systemPrompt}${suffix}`);
    }
    this.systemPromptSent = true;
    this.muted = false;
  }

  setContextReminder(reminder: string) {
    this.contextReminder = reminder;
  }

  /** Queue an urgent message to be prepended to the next send() call.
   *  Gemini spawns a new process per exec() so we cannot inject mid-execution. */
  sendUrgent(prompt: string) {
    this.urgentQueue.push(prompt);
    flog.info('AGENT', `Gemini: Urgent queued (${this.urgentQueue.length} pending): ${prompt.slice(0, 80)}`);
  }

  send(prompt: string) {
    this.muted = false;
    this.setStatus('running');

    // Drain urgent queue — prepend urgent messages before the main prompt
    let finalPrompt = prompt;
    if (this.urgentQueue.length > 0) {
      const urgentMessages = this.urgentQueue
        .map((m) => `[LIVE MESSAGE DU USER] ${m}`)
        .join('\n\n');
      finalPrompt = `${urgentMessages}\n\n${prompt}`;
      flog.info('AGENT', `Gemini: Drained ${this.urgentQueue.length} urgent messages`);
      this.urgentQueue = [];
    }

    // If session was lost but system prompt was already sent,
    // prepend a compact reminder
    if (!this.sessionId && this.systemPromptSent && this.contextReminder) {
      finalPrompt = `${this.contextReminder}\n\n${finalPrompt}`;
      flog.info('AGENT', 'Gemini: Session lost — prepending compact context reminder');
    }
    this.exec(finalPrompt).catch((err) => {
      flog.error('AGENT', `Gemini: exec error: ${err}`);
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
      const args: string[] = [];

      // Headless mode with prompt
      args.push('-p', prompt);

      // Stream JSON output
      args.push('-o', 'stream-json');

      // Model
      args.push('-m', 'gemini-2.5-pro');

      // Auto-approve edit tools (--yolo may be blocked by admin settings)
      args.push('--approval-mode', 'auto_edit');

      // Resume session if available
      if (this.sessionId) {
        args.push('--resume', this.sessionId);
      }

      flog.info('AGENT',
        `[GEMINI] Spawning: ${this.cliPath} -p "..." (prompt: ${prompt.slice(0, 80)})`,
      );

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
        flog.debug('AGENT', `[GEMINI stderr] ${line}`);
      });

      proc.on('error', (err) => {
        flog.error('AGENT', `[GEMINI] Process error: ${err.message}`);
        this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
        this.setStatus('error');
        this.activeProcess = null;
        reject(err);
      });

      proc.on('exit', (code) => {
        flog.info('AGENT', `[GEMINI] Process exited with code ${code}`);
        if (code !== null && code !== 0) {
          flog.warn('AGENT', `[GEMINI] Non-zero exit code: ${code}`);
          this.emit({
            text: `Gemini: processus termine avec code ${code}`,
            timestamp: Date.now(),
            type: 'info',
          });
        }
        this.activeProcess = null;
        this.setStatus('waiting');
        resolve(fullStdout);
      });
    });
  }

  private handleStreamEvent(event: Record<string, unknown>) {
    const eventType = event.type as string | undefined;
    flog.debug('AGENT', `[GEMINI event] ${eventType}`);

    // ── init event → capture session_id ──
    if (eventType === 'init') {
      const sid = event.session_id as string | undefined;
      if (sid) {
        this.sessionId = sid;
        flog.info('AGENT', `[GEMINI] Session ID: ${this.sessionId}`);
      }
      return;
    }

    // ── message event (role=assistant) → extract text content ──
    if (eventType === 'message') {
      const role = event.role as string | undefined;
      if (role === 'assistant') {
        // Content can be a string or an array of parts
        const content = event.content as string | Array<Record<string, unknown>> | undefined;
        if (typeof content === 'string' && content.trim()) {
          this.emit({ text: content, timestamp: Date.now(), type: 'stdout' });
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part.text === 'string' && (part.text as string).trim()) {
              this.emit({ text: part.text as string, timestamp: Date.now(), type: 'stdout' });
            }
          }
        }
      }
      return;
    }

    // ── toolCall event → show action ──
    if (eventType === 'toolCall') {
      const name = event.name as string | undefined;
      const args = event.args as Record<string, unknown> | undefined;
      if (name) {
        // Map Gemini tool calls to display-friendly actions
        let actionText: string | null = null;
        if (name === 'readFile' || name === 'read_file') {
          const path = (args?.path || args?.filename) as string | undefined;
          actionText = formatAction('read', path ?? name);
        } else if (name === 'listFiles' || name === 'list_files' || name === 'glob') {
          const pattern = (args?.pattern || args?.path) as string | undefined;
          actionText = formatAction('glob', pattern ?? '.');
        } else if (name === 'grep' || name === 'search') {
          const query = (args?.query || args?.pattern) as string | undefined;
          actionText = formatAction('grep', query ?? name);
        } else if (name === 'runShell' || name === 'shell' || name === 'bash') {
          const cmd = (args?.command || args?.cmd) as string | undefined;
          actionText = formatAction('bash', cmd ?? name);
        } else {
          actionText = formatAction('tool', `${name}`);
        }
        if (actionText) {
          this.emit({ text: actionText, timestamp: Date.now(), type: 'system' });
        }
      }
      return;
    }

    // ── result event → set status waiting ──
    if (eventType === 'result') {
      const text = event.result as string | undefined;
      if (text && text.trim()) {
        this.emit({ text, timestamp: Date.now(), type: 'stdout' });
      }
      this.setStatus('waiting');
      return;
    }

    // ── error event ──
    if (eventType === 'error') {
      const errorMsg = (event.message as string) || (event.error as string) || 'Unknown error';
      flog.error('AGENT', `[GEMINI] Error event: ${errorMsg}`);
      this.emit({ text: `Gemini error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
      return;
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async stop(): Promise<void> {
    if (this.activeProcess) {
      flog.info('AGENT', '[GEMINI] Stopping active process...');
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
