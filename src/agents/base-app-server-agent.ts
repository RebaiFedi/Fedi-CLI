import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentId, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { flog } from '../utils/log.js';
import { VERSION } from '../utils/version.js';
import { loadUserConfig } from '../config/user-config.js';
import { RpcClient } from './rpc-client.js';
import {
  handleItemStarted,
  handleItemCompleted,
  handleAgentMessageDelta,
  handleCommandOutputDelta,
  handleFileChangeOutputDelta,
  handleTurnDiffUpdated,
  handleError,
  type ItemHandlerDeps,
} from './item-handlers.js';

/**
 * Abstract base class for agents communicating via `codex app-server` (JSON-RPC 2.0).
 * Spawns ONE persistent process and communicates bidirectionally over stdin/stdout.
 *
 * Lifecycle:
 *   start()  → spawn process, handshake (initialize/initialized), create thread
 *   send()   → turn/start RPC
 *   sendUrgent() → turn/steer RPC (if turn active) or queue for next turn
 *   stop()   → turn/interrupt (if active), then SIGTERM/SIGKILL
 */
export abstract class BaseAppServerAgent implements AgentProcess {
  abstract readonly id: AgentId;
  status: AgentStatus = 'idle';
  lastError: string | null = null;

  protected process: ChildProcess | null = null;
  protected threadId: string | null = null;
  protected activeTurnId: string | null = null;
  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];
  private _rpc: RpcClient | null = null;

  /** RPC client accessor — throws if called before start(). */
  private get rpc(): RpcClient {
    if (!this._rpc) throw new Error(`${this.logTag}: RPC client not initialized — call start() first`);
    return this._rpc;
  }
  private urgentQueue: string[] = [];
  private muted = false;
  private stopped = false;
  private projectDir = '';
  private cliPath = '';
  private stdoutRl: ReturnType<typeof createInterface> | null = null;
  private stderrRl: ReturnType<typeof createInterface> | null = null;

  private pendingSystemPrompt: string | null = null;
  private systemPromptSent = false;
  private contextReminder = '';

  // Suppress the server echo of user messages (fused system prompt + task)
  // Each send() increments this, and item/completed decrements when it sees a user-role item.
  private suppressUserEchoCount = 0;

  // Agent message streaming: buffer deltas until item/completed assembles the final text.
  // This avoids emitting each token as a separate line.
  private agentMessageBuffer = '';
  // Whether any agentMessage/delta events were received for the current item.
  // If false, item/completed falls back to extractText() from the completed item.
  private hadAgentMessageDeltas = false;
  // How many chars of the agentMessageBuffer have already been streamed to the UI.
  private streamedLength = 0;

  private pendingFileChangeDiff: string | null = null;

  private pendingFileChangePath: string | null = null;
  private transientErrorCount = 0;

  /** Cached item handler deps — built once on start(), invalidated on stop() */
  private _cachedItemDeps: ItemHandlerDeps | null = null;

  // ── Abstract members ────────────────────────────────────────────────────

  protected abstract get logTag(): string;

  protected abstract get model(): string;

  protected abstract get effort(): string;

  protected abstract get thinking(): boolean;

  protected abstract getCliPath(config: SessionConfig): string;

  // ── Status & output management ──────────────────────────────────────────

  protected setStatus(s: AgentStatus) {
    this.status = s;
    if (s !== 'error') this.lastError = null;
    if (this.stopped && s !== 'stopped') return;
    if (this.muted && s !== 'waiting' && s !== 'stopped' && s !== 'error') return;
    this.statusHandlers.forEach((h) => h(s));
  }

  protected emit(line: OutputLine) {
    if (this.muted || this.stopped) return;
    this.outputHandlers.forEach((h) => h(line));
  }

  /** Emit a checkpoint event — bypasses mute so checkpoints pass through
   *  even when the agent is muted (relay buffering). Only stopped agents are silenced. */
  protected emitCheckpoint(text: string) {
    if (this.stopped) return;
    this.outputHandlers.forEach((h) =>
      h({
        text,
        timestamp: Date.now(),
        type: 'checkpoint',
      }),
    );
  }

  onOutput(handler: (line: OutputLine) => void) {
    this.outputHandlers.push(handler);
  }

  onStatusChange(handler: (status: AgentStatus) => void) {
    this.statusHandlers.push(handler);
  }

  clearHandlers(): void {
    this.outputHandlers.length = 0;
    this.statusHandlers.length = 0;
  }

  mute(): void {
    this.muted = true;
  }

  interruptCurrentTask(): void {
    if (this.activeTurnId && this.threadId && this.process?.stdin?.writable) {
      flog.info('AGENT', `${this.logTag}: Interrupting active turn ${this.activeTurnId}`);
      this.rpc
        .request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        })
        .catch((err) => {
          flog.debug('AGENT', `${this.logTag}: turn/interrupt failed (expected): ${err}`);
        });
    }
  }

  setContextReminder(reminder: string) {
    this.contextReminder = reminder;
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  // ── Item handler deps (bridge to extracted module) ──────────────────────

  private get itemDeps(): ItemHandlerDeps {
    if (this._cachedItemDeps) return this._cachedItemDeps;
    this._cachedItemDeps = {
      logTag: this.logTag,
      emit: (line) => this.emit(line),
      emitCheckpoint: (text) => this.emitCheckpoint(text),
      consumeEchoSuppression: () => {
        if (this.suppressUserEchoCount > 0) {
          this.suppressUserEchoCount--;
          return true;
        }
        return false;
      },
      getMessageBuffer: () => ({
        buffer: this.agentMessageBuffer,
        hadDeltas: this.hadAgentMessageDeltas,
      }),
      resetMessageBuffer: () => {
        this.agentMessageBuffer = '';
        this.hadAgentMessageDeltas = false;
        this.streamedLength = 0;
      },
      appendToMessageBuffer: (delta) => {
        this.agentMessageBuffer += delta;
        this.hadAgentMessageDeltas = true;
      },
      getStreamedLength: () => this.streamedLength,
      setStreamedLength: (n) => {
        this.streamedLength = n;
      },
      getPendingFileChangeDiff: () => this.pendingFileChangeDiff,
      setPendingFileChangeDiff: (d) => {
        this.pendingFileChangeDiff = d;
      },
      getPendingFileChangePath: () => this.pendingFileChangePath,
      setPendingFileChangePath: (p) => {
        this.pendingFileChangePath = p;
      },
    };
    return this._cachedItemDeps;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(
    config: SessionConfig,
    systemPrompt: string,
    options?: { muted?: boolean },
  ): Promise<void> {
    this.stopped = false;
    this.projectDir = config.projectDir;
    this.cliPath = this.getCliPath(config);
    this.muted = options?.muted ?? false;

    if (this.process) {
      flog.warn('AGENT', `${this.logTag}: Already running, stopping first`);
      await this.stop();
    }

    // Initialize RPC client
    this._rpc = new RpcClient(() => this.process, this.logTag);

    // Spawn the app-server process
    const args = ['app-server'];
    flog.info('AGENT', `${this.logTag}: Spawning: ${this.cliPath} ${args.join(' ')}`);

    this.process = spawn(this.cliPath, args, {
      cwd: this.projectDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Create new process group so we can kill the entire tree on stop
      detached: true,
    });

    // Wire up stdout line reader
    const rl = createInterface({ input: this.process.stdout! });
    this.stdoutRl = rl;
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        this.handleServerMessage(msg);
      } catch {
        flog.debug('AGENT', `${this.logTag}: non-JSON stdout: ${line.slice(0, 120)}`);
      }
    });

    // Wire up stderr
    const stderrRl = createInterface({ input: this.process.stderr! });
    this.stderrRl = stderrRl;
    stderrRl.on('line', (line) => {
      if (!line.trim()) return;
      if (
        /reconnect/i.test(line) ||
        /stream disconnect/i.test(line) ||
        /connection closed/i.test(line)
      ) {
        this.transientErrorCount++;
        flog.warn('AGENT', `${this.logTag} stderr (transient #${this.transientErrorCount}): ${line.slice(0, 200)}`);
        if (this.transientErrorCount >= 3) {
          this.emit({
            text: `${this.logTag}: connexion instable (${this.transientErrorCount} erreurs) — retry en cours`,
            timestamp: Date.now(),
            type: 'info',
          });
        }
        return;
      }
      flog.debug('AGENT', `${this.logTag} stderr: ${line}`);
    });

    this.process.on('exit', (code, signal) => {
      flog.info('AGENT', `${this.logTag}: Process exited (code=${code}, signal=${signal})`);
      this.process = null;
      this.cleanupReadlines();
      this._rpc?.rejectAllNoTimeout(`${this.logTag}: process exited (code=${code})`);
      if (!this.stopped) {
        this.setStatus('error');
      }
    });

    this.process.on('error', (err) => {
      flog.error('AGENT', `${this.logTag}: Process error: ${err.message}`);
      this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
      if (!this.stopped) {
        this.setStatus('error');
      }
    });

    // ── Handshake ──
    try {
      await this.rpc.request('initialize', {
        clientInfo: { name: 'fedi-cli', version: VERSION },
      });
      this.rpc.notify('initialized', {});
      flog.info('AGENT', `${this.logTag}: Handshake complete`);
    } catch (err) {
      flog.error('AGENT', `${this.logTag}: Handshake failed: ${err}`);
      this.lastError = String(err);
      this.setStatus('error');
      return;
    }

    // ── Thread creation or resume ──
    try {
      if (this.threadId) {
        flog.info('AGENT', `${this.logTag}: Resuming thread ${this.threadId}`);
        await this.rpc.request('thread/resume', {
          threadId: this.threadId,
        });
        this.systemPromptSent = true;
      } else {
        const sandbox = loadUserConfig().sandboxMode;
        const result = (await this.rpc.request('thread/start', {
          model: this.model,
          cwd: this.projectDir,
          approvalPolicy: sandbox ? 'on-request' : 'never',
          sandbox: sandbox ? 'workspace-write' : 'danger-full-access',
        })) as { thread?: { id?: string } };
        if (result?.thread?.id) {
          this.threadId = result.thread.id;
          flog.info('AGENT', `${this.logTag}: Thread created: ${this.threadId}`);
        }
      }
    } catch (err) {
      flog.error('AGENT', `${this.logTag}: Thread setup failed: ${err}`);
      this.lastError = String(err);
      this.setStatus('error');
      return;
    }

    if (this.threadId) {
      this.emitCheckpoint(`[CODEX:started] Thread ${this.threadId}`);
    }

    if (this.threadId && this.systemPromptSent) {
      this.setStatus('running');
      const resumeMsg = options?.muted
        ? '[Session reprise] Tu es en standby. Attends une tache.'
        : '[Session reprise] Continue ton travail.';
      this.suppressUserEchoCount++;
      this.startTurn(resumeMsg);
    } else {
      // System prompt is normally loaded via AGENTS.md.
      // If AGENTS.md was not written (user-managed), keep the prompt as pending
      // so it gets fused with the first user message as a fallback.
      if (systemPrompt && systemPrompt.length > 0) {
        this.pendingSystemPrompt = systemPrompt;
        flog.info('AGENT', `${this.logTag}: Ready — system prompt stored as fallback`);
      } else {
        this.pendingSystemPrompt = null;
        flog.info('AGENT', `${this.logTag}: Ready — no system prompt provided`);
      }
      this.setStatus('idle');
      this.systemPromptSent = true;
    }
    // Only unmute if not explicitly started as muted (standby workers)
    if (!options?.muted) {
      this.muted = false;
    }
  }

  send(prompt: string) {
    this.stopped = false;
    this.muted = false;
    this.setStatus('running');

    let finalPrompt = prompt;

    if (this.pendingSystemPrompt) {
      finalPrompt = `${this.pendingSystemPrompt}\n\n${prompt}`;
      flog.info('AGENT', `${this.logTag}: Fused system prompt with first task`);
      this.pendingSystemPrompt = null;
      this.systemPromptSent = true;
    }

    this.suppressUserEchoCount++;

    if (this.urgentQueue.length > 0) {
      const urgentMessages = this.urgentQueue
        .map((m) => `[LIVE MESSAGE DU USER] ${m}`)
        .join('\n\n');
      finalPrompt = `${urgentMessages}\n\n${finalPrompt}`;
      flog.info('AGENT', `${this.logTag}: Drained ${this.urgentQueue.length} urgent messages`);
      this.urgentQueue = [];
    }

    if (
      !this.threadId &&
      this.systemPromptSent &&
      this.contextReminder &&
      !this.pendingSystemPrompt
    ) {
      finalPrompt = `${this.contextReminder}\n\n${finalPrompt}`;
      flog.info('AGENT', `${this.logTag}: Session lost — prepending compact context reminder`);
    }

    this.startTurn(finalPrompt);
  }

  sendUrgent(prompt: string) {
    if (this.activeTurnId && this.threadId && this.process?.stdin?.writable) {
      flog.info('AGENT', `${this.logTag}: Steering active turn with urgent message`);
      this.rpc
        .request('turn/steer', {
          threadId: this.threadId,
          input: [{ type: 'text', text: `[LIVE MESSAGE DU USER] ${prompt}` }],
          expectedTurnId: this.activeTurnId,
        })
        .catch((err) => {
          flog.warn('AGENT', `${this.logTag}: turn/steer failed: ${err}`);
          this.urgentQueue.push(prompt);
        });
    } else {
      this.urgentQueue.push(prompt);
      flog.info(
        'AGENT',
        `${this.logTag}: Urgent queued (${this.urgentQueue.length} pending): ${prompt.slice(0, 80)}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.urgentQueue = [];
    this._cachedItemDeps = null;

    if (this.activeTurnId && this.threadId && this.process?.stdin?.writable) {
      try {
        await this.rpc.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        });
      } catch (err) {
        flog.debug(
          'AGENT',
          `${this.logTag}: turn/interrupt failed (expected during shutdown): ${err}`,
        );
      }
      this.activeTurnId = null;
    }

    const proc = this.process;
    if (proc) {
      flog.info('AGENT', `${this.logTag}: Stopping process...`);
      this.cleanupReadlines();
      proc.stdin?.end();
      this.killProcessGroup(proc, 'SIGTERM');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.killProcessGroup(proc, 'SIGKILL');
          flog.warn('AGENT', `${this.logTag}: Force killed after 3s`);
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
    }

    this._rpc?.rejectAll(`${this.logTag}: stopped`);
    this.setStatus('stopped');
  }

  /** Kill the process and its entire process group. */
  private killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
    try {
      // Negative PID is only supported on POSIX platforms (Linux, macOS).
      if (proc.pid && process.platform !== 'win32') {
        process.kill(-proc.pid, signal);
      } else if (proc.pid) {
        proc.kill(signal);
      }
    } catch {
      try {
        proc.kill(signal);
      } catch (err) {
        flog.debug(
          'AGENT',
          `${this.logTag}: ${signal} ignored in stop(): ${String(err).slice(0, 120)}`,
        );
      }
    }
  }

  // ── Turn management ─────────────────────────────────────────────────────

  private mapEffort(): string {
    const effortMap: Record<string, string> = {
      high: 'xhigh',
      medium: 'high',
      low: 'medium',
    };
    return effortMap[this.effort] ?? 'xhigh';
  }

  private startTurn(prompt: string) {
    if (!this.threadId || !this.process?.stdin?.writable) {
      flog.error('AGENT', `${this.logTag}: Cannot start turn — no thread or process`);
      this.emit({
        text: `${this.logTag}: processus mort — redemarrage necessaire`,
        timestamp: Date.now(),
        type: 'info',
      });
      this.setStatus('error');
      return;
    }

    const sandboxOn = loadUserConfig().sandboxMode;
    const turnParams: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      model: this.model,
      effort: this.mapEffort(),
      approvalPolicy: sandboxOn ? 'on-request' : 'never',
      sandboxPolicy: sandboxOn ? { type: 'workspaceWrite' } : { type: 'dangerFullAccess' },
    };

    if (this.thinking) {
      turnParams.thinking = true;
    }

    this.rpc.request('turn/start', turnParams).catch((err) => {
      flog.error('AGENT', `${this.logTag}: turn/start failed: ${err}`);
      this.emit({ text: `[TURN_FAILED] ${err}`, timestamp: Date.now(), type: 'info' });
      this.setStatus('error');
    });
  }

  // ── Server message dispatch ─────────────────────────────────────────────

  /** Dispatch map: method name → handler. Built lazily, cached for the instance lifetime. */
  private _dispatchMap: Map<string, (params: Record<string, unknown>, msg: Record<string, unknown>) => void> | null = null;

  private getDispatchMap(): Map<string, (params: Record<string, unknown>, msg: Record<string, unknown>) => void> {
    if (this._dispatchMap) return this._dispatchMap;
    const noop = () => { }; // ignored events
    const approvalHandler = (_p: Record<string, unknown>, msg: Record<string, unknown>) => this.handleRequestApproval(msg);

    this._dispatchMap = new Map<string, (params: Record<string, unknown>, msg: Record<string, unknown>) => void>([
      ['turn/started', (p) => this.handleTurnStarted(p)],
      ['turn/completed', () => this.handleTurnCompleted()],
      ['item/started', (p) => handleItemStarted(this.itemDeps, p)],
      ['item/completed', (p) => handleItemCompleted(this.itemDeps, p)],
      ['item/agentMessage/delta', (p) => handleAgentMessageDelta(this.itemDeps, p)],
      ['item/commandExecution/outputDelta', (p) => handleCommandOutputDelta(this.logTag, p)],
      ['item/commandExecution/requestApproval', approvalHandler],
      ['item/fileChange/requestApproval', approvalHandler],
      ['execCommandApproval', approvalHandler],
      ['applyPatchApproval', approvalHandler],
      ['item/tool/requestUserInput', (_p, msg) => this.handleToolUserInput(msg)],
      ['item/fileChange/outputDelta', (p) => handleFileChangeOutputDelta(this.itemDeps, p)],
      ['turn/diff/updated', (p) => handleTurnDiffUpdated(this.logTag, this.itemDeps, p)],
      ['thread/compacted', () => this.handleCompacted()],
      ['error', (p) => handleError(
        this.logTag,
        (line) => this.emit(line),
        () => this.setStatus('error'),
        (e) => { this.lastError = e; },
        p,
      )],
      // Low-value events — ignored
      ['turn/plan/updated', noop],
      ['item/plan/delta', noop],
      ['item/reasoning/textDelta', noop],
      ['item/reasoning/summaryTextDelta', noop],
      ['item/reasoning/summaryPartAdded', noop],
      ['item/mcpToolCall/progress', noop],
      ['thread/started', noop],
      ['thread/status/changed', noop],
      ['thread/name/updated', noop],
      ['thread/tokenUsage/updated', noop],
      ['model/rerouted', noop],
      ['account/updated', noop],
      ['account/rateLimits/updated', noop],
      ['configWarning', noop],
      ['deprecationNotice', noop],
    ]);
    return this._dispatchMap;
  }

  private handleServerMessage(msg: Record<string, unknown>) {
    // RPC response
    if (this._rpc?.handleResponse(msg)) return;

    // Server request or notification
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (!method) {
      flog.debug(
        'AGENT',
        `${this.logTag}: Unknown server message: ${JSON.stringify(msg).slice(0, 200)}`,
      );
      return;
    }

    const params =
      msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};

    flog.debug('AGENT', `${this.logTag}: event ${method}`);

    const handler = this.getDispatchMap().get(method);
    if (handler) {
      handler(params, msg);
    } else {
      flog.debug('AGENT', `${this.logTag}: Unhandled notification: ${method}`);
    }
  }

  // ── Turn event handlers (kept in class — they modify activeTurnId) ──────

  private handleTurnStarted(params: Record<string, unknown>) {
    let turnId: string | undefined;
    if (params.turn && typeof params.turn === 'object') {
      const turn = params.turn as Record<string, unknown>;
      if (typeof turn.id === 'string') turnId = turn.id;
    }
    this.activeTurnId = turnId ?? null;
    this.transientErrorCount = 0;
    if (this.status !== 'running') this.setStatus('running');
    flog.info('AGENT', `${this.logTag}: Turn started: ${turnId ?? 'unknown'}`);
  }

  private handleTurnCompleted() {
    this.activeTurnId = null;
    this.emitCheckpoint(`[CODEX:done] Turn completed`);
    this.setStatus('waiting');
    flog.info('AGENT', `${this.logTag}: Turn completed`);
  }

  private handleCompacted() {
    flog.warn('AGENT', `${this.logTag}: Context window compacted`);
    const prevStatus = this.status;
    this.setStatus('compacting');
    // Log only — no UI emit. The status badge already shows compacting state.
    this.setStatus(prevStatus === 'compacting' ? 'running' : prevStatus);
  }

  // ── Approval/input handlers (kept in class — they need process.stdin) ───

  private handleRequestApproval(msg: Record<string, unknown>) {
    const id = typeof msg.id === 'number' ? msg.id : undefined;
    if (id === undefined) {
      flog.warn('AGENT', `${this.logTag}: Approval request without id — cannot respond`);
      return;
    }

    const method = typeof msg.method === 'string' ? msg.method : 'unknown';
    const params =
      msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};
    const command = typeof params.command === 'string' ? params.command : undefined;
    const detail = command ? ` (command: ${command.slice(0, 100)})` : '';

    // TODO: Implement a proper approval UI that lets users review and accept/reject
    // individual operations. Currently auto-accepting because the Codex app-server
    // protocol requires a synchronous response and we have no interactive prompt.
    if (loadUserConfig().sandboxMode) {
      flog.warn(
        'AGENT',
        `${this.logTag}: Auto-accepting ${method} #${id}${detail} (approval UI not yet implemented)`,
      );
    } else {
      flog.debug('AGENT', `${this.logTag}: Auto-accepting ${method} #${id}${detail} (unsafe mode)`);
    }

    const response = JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { decision: 'accept' },
    });
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(response + '\n');
    }
  }

  private handleToolUserInput(msg: Record<string, unknown>) {
    const id = msg.id;
    if (id !== undefined) {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { response: '' },
      });
      if (this.process?.stdin?.writable) {
        this.process.stdin.write(response + '\n');
        flog.debug('AGENT', `${this.logTag}: Auto-responded to tool user input #${id}`);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private cleanupReadlines() {
    if (this.stdoutRl) {
      this.stdoutRl.removeAllListeners();
      try {
        this.stdoutRl.close();
      } catch {
        /* ignore */
      }
      this.stdoutRl = null;
    }
    if (this.stderrRl) {
      this.stderrRl.removeAllListeners();
      try {
        this.stderrRl.close();
      } catch {
        /* ignore */
      }
      this.stderrRl = null;
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  isInterrupted(): boolean {
    return false;
  }
}
