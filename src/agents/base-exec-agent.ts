import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentId, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { flog } from '../utils/log.js';
import { loadUserConfig } from '../config/user-config.js';

/**
 * Abstract base class for spawn-per-exec agents (Codex, Gemini).
 * Each send() spawns a new child process. Provides common:
 * - Status/output handler management with muting
 * - Urgent message queue (drained at next send)
 * - Exec serialization via lock
 * - Exec timeout safety net
 * - Graceful stop with SIGTERM/SIGKILL
 * - Context reminder for session-loss recovery
 */
export abstract class BaseExecAgent implements AgentProcess {
  abstract readonly id: AgentId;
  status: AgentStatus = 'idle';

  protected sessionId: string | null = null;
  protected projectDir: string = '';
  protected cliPath: string = '';
  protected systemPromptSent = false;
  protected contextReminder: string = '';
  protected muted = false;
  protected activeProcess: ChildProcess | null = null;

  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];
  private execLock: Promise<string> | null = null;
  private urgentQueue: string[] = [];

  /** Max execution time per exec call */
  protected static readonly EXEC_TIMEOUT_MS = loadUserConfig().execTimeoutMs;

  /** Human-readable tag for log messages */
  protected abstract get logTag(): string;

  /** Extract CLI path from SessionConfig */
  protected abstract getCliPath(config: SessionConfig): string;

  /** Build CLI arguments for a given prompt */
  protected abstract buildArgs(prompt: string): string[];

  /** Handle a parsed JSON stream event from the child process */
  protected abstract handleStreamEvent(event: Record<string, unknown>): void;

  /** Optional: filter non-JSON lines (return true to suppress) */
  protected isNoiseLine(_line: string): boolean {
    return false;
  }

  /** Optional: handle stderr lines (default: debug log) */
  protected handleStderrLine(line: string): void {
    flog.debug('AGENT', `${this.logTag} stderr: ${line}`);
  }

  // ── Status & output management ────────────────────────────────────────

  protected setStatus(s: AgentStatus) {
    this.status = s;
    if (this.muted && s !== 'waiting' && s !== 'stopped' && s !== 'error') return;
    this.statusHandlers.forEach((h) => h(s));
  }

  protected emit(line: OutputLine) {
    if (this.muted) return;
    this.outputHandlers.forEach((h) => h(line));
  }

  onOutput(handler: (line: OutputLine) => void) {
    this.outputHandlers.push(handler);
  }

  onStatusChange(handler: (status: AgentStatus) => void) {
    this.statusHandlers.push(handler);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(
    config: SessionConfig,
    systemPrompt: string,
    options?: { muted?: boolean },
  ): Promise<void> {
    this.projectDir = config.projectDir;
    this.cliPath = this.getCliPath(config);

    this.muted = options?.muted ?? false;
    this.setStatus('running');

    if (this.sessionId) {
      const resumeMsg = options?.muted
        ? '[Session reprise] Tu es en standby. Attends une tache.'
        : '[Session reprise] Continue ton travail.';
      flog.info('AGENT', `${this.logTag}: Resuming session ${this.sessionId}`);
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

  sendUrgent(prompt: string) {
    this.urgentQueue.push(prompt);
    flog.info('AGENT', `${this.logTag}: Urgent queued (${this.urgentQueue.length} pending): ${prompt.slice(0, 80)}`);
  }

  send(prompt: string) {
    this.muted = false;
    this.setStatus('running');

    let finalPrompt = prompt;
    if (this.urgentQueue.length > 0) {
      const urgentMessages = this.urgentQueue
        .map((m) => `[LIVE MESSAGE DU USER] ${m}`)
        .join('\n\n');
      finalPrompt = `${urgentMessages}\n\n${prompt}`;
      flog.info('AGENT', `${this.logTag}: Drained ${this.urgentQueue.length} urgent messages`);
      this.urgentQueue = [];
    }

    if (!this.sessionId && this.systemPromptSent && this.contextReminder) {
      finalPrompt = `${this.contextReminder}\n\n${finalPrompt}`;
      flog.info('AGENT', `${this.logTag}: Session lost — prepending compact context reminder`);
    }

    this.exec(finalPrompt).catch((err) => {
      flog.error('AGENT', `${this.logTag}: exec error: ${err}`);
      this.setStatus('error');
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async stop(): Promise<void> {
    const proc = this.activeProcess;
    if (proc) {
      flog.info('AGENT', `${this.logTag}: Stopping active process...`);
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }, 3000);
        proc.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.activeProcess = null;
    }
    this.setStatus('stopped');
  }

  // ── Exec serialization ────────────────────────────────────────────────

  protected async exec(prompt: string): Promise<string> {
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

  private _doExec(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(prompt);
      const timeoutMs = (this.constructor as typeof BaseExecAgent).EXEC_TIMEOUT_MS;

      flog.info('AGENT',
        `${this.logTag}: Spawning: ${this.cliPath} ${args.slice(0, 3).join(' ')}... (prompt: ${prompt.slice(0, 80)})`,
      );

      const proc = spawn(this.cliPath, args, {
        cwd: this.projectDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcess = proc;
      let fullStdout = '';
      let settled = false;

      const execTimeout = setTimeout(() => {
        if (settled) return;
        flog.warn('AGENT', `${this.logTag}: Exec timeout after ${timeoutMs / 1000}s — killing process`);
        this.emit({ text: `${this.logTag}: timeout — processus termine`, timestamp: Date.now(), type: 'info' });
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, timeoutMs);

      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        fullStdout += line + '\n';
        try {
          const event = JSON.parse(line);
          this.handleStreamEvent(event);
        } catch {
          if (this.isNoiseLine(line)) {
            flog.debug('AGENT', `${this.logTag}: Filtered noise: ${line.slice(0, 80)}`);
            return;
          }
          this.emit({ text: line, timestamp: Date.now(), type: 'stdout' });
        }
      });

      const stderrRl = createInterface({ input: proc.stderr! });
      stderrRl.on('line', (line) => {
        if (!line.trim()) return;
        this.handleStderrLine(line);
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(execTimeout);
        flog.error('AGENT', `${this.logTag}: Process error: ${err.message}`);
        this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
        this.setStatus('error');
        this.activeProcess = null;
        reject(err);
      });

      proc.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(execTimeout);
        flog.info('AGENT', `${this.logTag}: Process exited with code ${code}`);
        if (code !== null && code !== 0) {
          flog.warn('AGENT', `${this.logTag}: Non-zero exit code: ${code}`);
          this.emit({
            text: `${this.logTag}: processus termine avec code ${code}`,
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
}
