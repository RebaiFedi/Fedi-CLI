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
  private abortController: AbortController = new AbortController();

  /** Max execution time per exec call */
  protected static readonly EXEC_TIMEOUT_MS = loadUserConfig().execTimeoutMs;

  private static readonly MAX_EXEC_RETRIES = 2;
  private static readonly RETRY_BACKOFF_MS = 5_000;

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

  private ensureAbortController() {
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
  }

  private emitExecFailed(err: unknown) {
    const message = String(err);
    this.emit({
      text: `[EXEC_FAILED] ${message}`,
      timestamp: Date.now(),
      type: 'system',
    });
  }

  private async sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new Error(`${this.logTag}: aborted`);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`${this.logTag}: aborted`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
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

  mute(): void {
    this.muted = true;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(
    config: SessionConfig,
    systemPrompt: string,
    options?: { muted?: boolean },
  ): Promise<void> {
    this.ensureAbortController();
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
    this.ensureAbortController();
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
      this.emit({ text: `[EXEC_FAILED] ${err}`, timestamp: Date.now(), type: 'info' });
      this.setStatus('error');
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    this.abortController = new AbortController();

    const proc = this.activeProcess;
    if (proc) {
      flog.info('AGENT', `${this.logTag}: Stopping active process...`);
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch (err) {
            flog.debug('AGENT', `${this.logTag}: SIGKILL ignored in stop(): ${String(err).slice(0, 120)}`);
          }
          resolve();
        }, 3000);
        proc.once('exit', () => {
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
    const previous = this.execLock ?? Promise.resolve('');
    const next = previous.then(
      () => this._execWithRetry(prompt),
      () => this._execWithRetry(prompt),
    );
    this.execLock = next.then(() => '', () => '');
    return next;
  }

  private async _execWithRetry(prompt: string): Promise<string> {
    const maxRetries = (this.constructor as typeof BaseExecAgent).MAX_EXEC_RETRIES;
    const backoffMs = (this.constructor as typeof BaseExecAgent).RETRY_BACKOFF_MS;
    const signal = this.abortController.signal;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) {
        const err = new Error(`${this.logTag}: aborted`);
        this.emitExecFailed(err);
        throw err;
      }
      try {
        return await this._doExec(prompt);
      } catch (err) {
        if (signal.aborted) {
          this.emitExecFailed(err);
          throw err;
        }
        if (attempt >= maxRetries) throw err;
        const baseWait = backoffMs * Math.pow(3, attempt); // 5s, 15s
        const jitter = Math.random() * 0.4 * baseWait - 0.2 * baseWait;
        const waitMs = Math.round(baseWait + jitter);
        flog.warn(
          'AGENT',
          `${this.logTag}: Exec failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${waitMs / 1000}s: ${String(err).slice(0, 100)}`,
        );
        this.emit({
          text: `${this.logTag}: echec execution — retry dans ${Math.round(waitMs / 1000)}s...`,
          timestamp: Date.now(),
          type: 'info',
        });
        await this.sleepWithAbort(waitMs, signal);
      }
    }
    const finalErr = new Error(`${this.logTag}: exec failed after retries`);
    this.emitExecFailed(finalErr);
    throw finalErr;
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
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          flog.debug('AGENT', `${this.logTag}: SIGKILL ignored on timeout: ${String(err).slice(0, 120)}`);
        }
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

      const closeReadlines = () => {
        try {
          rl.close();
        } catch (err) {
          flog.debug('AGENT', `${this.logTag}: stdout readline close ignored: ${String(err).slice(0, 120)}`);
        }
        try {
          stderrRl.close();
        } catch (err) {
          flog.debug('AGENT', `${this.logTag}: stderr readline close ignored: ${String(err).slice(0, 120)}`);
        }
      };

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(execTimeout);
        closeReadlines();
        flog.error('AGENT', `${this.logTag}: Process error: ${err.message}`);
        this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
        this.setStatus('error');
        this.activeProcess = null;
        this.emitExecFailed(err);
        reject(err);
      });

      proc.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(execTimeout);
        closeReadlines();
        flog.info('AGENT', `${this.logTag}: Process exited with code ${code}`);
        if (code !== null && code !== 0) {
          flog.warn('AGENT', `${this.logTag}: Non-zero exit code: ${code}`);
          this.emit({
            text: `${this.logTag}: processus termine avec code ${code}`,
            timestamp: Date.now(),
            type: 'info',
          });
          this.emitExecFailed(new Error(`${this.logTag}: exit code ${code}`));
        }
        this.activeProcess = null;
        this.setStatus('waiting');
        resolve(fullStdout);
      });
    });
  }
}
