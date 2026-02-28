import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentId, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { flog } from '../utils/log.js';
import { loadUserConfig } from '../config/user-config.js';

/**
 * Abstract base class for spawn-per-exec agents (Codex).
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
  lastError: string | null = null;

  protected sessionId: string | null = null;
  protected projectDir: string = '';
  protected cliPath: string = '';
  protected systemPromptSent = false;
  protected contextReminder: string = '';
  protected muted = false;
  protected activeProcess: ChildProcess | null = null;
  /** Stored system prompt — fused with first send() to avoid a wasted exec() */
  private pendingSystemPrompt: string | null = null;

  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];
  private execLock: Promise<string> | null = null;
  private urgentQueue: string[] = [];
  private abortController: AbortController = new AbortController();
  /** When true, all new exec() calls are rejected immediately. Set by stop(). */
  private stopped = false;

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
    this.lastError = message;
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
    if (s !== 'error') this.lastError = null;
    // When stopped, only emit the 'stopped' status itself — suppress all other
    // status transitions to prevent the orchestrator from triggering fallback logic
    if (this.stopped && s !== 'stopped') return;
    if (this.muted && s !== 'waiting' && s !== 'stopped' && s !== 'error') return;
    this.statusHandlers.forEach((h) => h(s));
  }

  protected emit(line: OutputLine) {
    if (this.muted || this.stopped) return;
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
    this.stopped = false;
    this.ensureAbortController();
    this.projectDir = config.projectDir;
    this.cliPath = this.getCliPath(config);

    this.muted = options?.muted ?? false;

    if (this.sessionId) {
      // Resuming an existing session — must exec immediately (session already has context)
      this.setStatus('running');
      const resumeMsg = options?.muted
        ? '[Session reprise] Tu es en standby. Attends une tache.'
        : '[Session reprise] Continue ton travail.';
      flog.info('AGENT', `${this.logTag}: Resuming session ${this.sessionId}`);
      await this.exec(resumeMsg);
      this.systemPromptSent = true;
      this.muted = false;
    } else {
      // First start — store system prompt and fuse it with the first real send().
      // This avoids a wasted exec() that just gets "Pret." back.
      this.pendingSystemPrompt = systemPrompt;
      this.setStatus('idle');
      flog.info('AGENT', `${this.logTag}: System prompt stored — will fuse with first send()`);
      this.systemPromptSent = false;
      this.muted = false;
    }
  }

  setContextReminder(reminder: string) {
    this.contextReminder = reminder;
  }

  sendUrgent(prompt: string) {
    this.urgentQueue.push(prompt);
    flog.info('AGENT', `${this.logTag}: Urgent queued (${this.urgentQueue.length} pending): ${prompt.slice(0, 80)}`);
  }

  send(prompt: string) {
    this.stopped = false;
    this.ensureAbortController();
    this.muted = false;
    this.setStatus('running');

    let finalPrompt = prompt;

    // Fuse pending system prompt with first real task — single exec instead of two
    if (this.pendingSystemPrompt) {
      finalPrompt = `${this.pendingSystemPrompt}\n\n${prompt}`;
      flog.info('AGENT', `${this.logTag}: Fused system prompt with first task (saving one exec)`);
      this.pendingSystemPrompt = null;
      this.systemPromptSent = true;
    }

    if (this.urgentQueue.length > 0) {
      const urgentMessages = this.urgentQueue
        .map((m) => `[LIVE MESSAGE DU USER] ${m}`)
        .join('\n\n');
      finalPrompt = `${urgentMessages}\n\n${finalPrompt}`;
      flog.info('AGENT', `${this.logTag}: Drained ${this.urgentQueue.length} urgent messages`);
      this.urgentQueue = [];
    }

    if (!this.sessionId && this.systemPromptSent && this.contextReminder && !this.pendingSystemPrompt) {
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
    // Mark as stopped FIRST — prevents any new exec() from spawning processes
    this.stopped = true;
    this.abortController.abort();

    // Clear the exec lock chain so no queued exec can run after stop
    this.execLock = null;
    // Clear urgent queue so no buffered messages survive the stop
    this.urgentQueue = [];

    const proc = this.activeProcess;
    if (proc && proc.pid) {
      flog.info('AGENT', `${this.logTag}: Stopping active process (pid=${proc.pid})...`);
      // Kill the entire process group (negative PID) so child processes are also terminated.
      // The process was spawned with detached:true to create a separate process group.
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        // Fallback to direct kill if process group kill fails
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            process.kill(-proc.pid!, 'SIGKILL');
          } catch {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          }
          resolve();
        }, 2000);
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.activeProcess = null;
    } else if (proc) {
      // No PID available — fallback to direct kill
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.activeProcess = null;
    }
    this.setStatus('stopped');
  }

  // ── Exec serialization ────────────────────────────────────────────────

  protected async exec(prompt: string): Promise<string> {
    if (this.stopped) {
      throw new Error(`${this.logTag}: stopped — exec rejected`);
    }
    const previous = this.execLock ?? Promise.resolve('');
    const next = previous.then(
      () => {
        if (this.stopped) throw new Error(`${this.logTag}: stopped — exec rejected`);
        return this._execWithRetry(prompt);
      },
      () => {
        if (this.stopped) throw new Error(`${this.logTag}: stopped — exec rejected`);
        return this._execWithRetry(prompt);
      },
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
        // Create a new process group so we can kill the entire tree on stop()
        detached: true,
      });

      this.activeProcess = proc;
      let fullStdout = '';
      let settled = false;

      // timeoutMs <= 0 means no timeout — wait indefinitely
      const execTimeout = timeoutMs > 0 ? setTimeout(() => {
        if (settled) return;
        flog.warn('AGENT', `${this.logTag}: Exec timeout after ${timeoutMs / 1000}s — killing process`);
        this.emit({ text: `${this.logTag}: timeout — processus termine`, timestamp: Date.now(), type: 'info' });
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          flog.debug('AGENT', `${this.logTag}: SIGKILL ignored on timeout: ${String(err).slice(0, 120)}`);
        }
      }, timeoutMs) : null;

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
        if (execTimeout) clearTimeout(execTimeout);
        closeReadlines();
        this.activeProcess = null;
        // If agent was stopped by user (Esc), don't emit error — just reject silently
        if (this.stopped) {
          flog.info('AGENT', `${this.logTag}: Process error during stop (ignored): ${err.message}`);
          reject(err);
          return;
        }
        flog.error('AGENT', `${this.logTag}: Process error: ${err.message}`);
        this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
        this.setStatus('error');
        this.emitExecFailed(err);
        reject(err);
      });

      proc.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        if (execTimeout) clearTimeout(execTimeout);
        closeReadlines();
        flog.info('AGENT', `${this.logTag}: Process exited with code ${code}, signal ${signal}`);
        this.activeProcess = null;
        if (signal) {
          // If agent was stopped by user (Esc), don't set 'error' status — the
          // orchestrator already set 'stopped' and we must not override it.
          // Setting 'error' here was causing the orchestrator to trigger fallback
          // logic (re-delegation) even after the user pressed Escape.
          if (this.stopped) {
            flog.info('AGENT', `${this.logTag}: Killed by ${signal} during stop (expected)`);
            reject(new Error(`${this.logTag}: stopped`));
            return;
          }
          flog.warn('AGENT', `${this.logTag}: Killed by signal: ${signal}`);
          this.emit({
            text: `${this.logTag}: processus tue par ${signal}`,
            timestamp: Date.now(),
            type: 'info',
          });
          const err = new Error(`${this.logTag}: killed by ${signal}`);
          this.emitExecFailed(err);
          this.setStatus('error');
          reject(err);
          return;
        }
        if (code !== null && code !== 0) {
          // If the agent already produced meaningful output, treat non-zero exit
          // as a warning rather than a fatal error (e.g. Codex reconnection failures
          // that happen AFTER the work was already completed successfully).
          if (fullStdout.trim().length > 0) {
            flog.warn('AGENT', `${this.logTag}: Non-zero exit code ${code} but has output (${fullStdout.length} chars) — treating as success`);
            this.emit({
              text: `${this.logTag}: termine avec code ${code} (output present — traite comme succes)`,
              timestamp: Date.now(),
              type: 'info',
            });
            this.setStatus('waiting');
            resolve(fullStdout);
            return;
          }
          flog.warn('AGENT', `${this.logTag}: Non-zero exit code: ${code}`);
          this.emit({
            text: `${this.logTag}: processus termine avec code ${code}`,
            timestamp: Date.now(),
            type: 'info',
          });
          const err = new Error(`${this.logTag}: exit code ${code}`);
          this.emitExecFailed(err);
          this.setStatus('error');
          reject(err);
          return;
        }
        this.setStatus('waiting');
        resolve(fullStdout);
      });
    });
  }
}
