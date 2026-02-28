import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentId, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { flog } from '../utils/log.js';
import { formatAction } from '../utils/format-action.js';

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
  private rpcId = 0;
  private pendingRpc: Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }> = new Map();
  private urgentQueue: string[] = [];
  private muted = false;
  private stopped = false;
  private projectDir = '';
  private cliPath = '';
  private stdoutRl: ReturnType<typeof createInterface> | null = null;
  private stderrRl: ReturnType<typeof createInterface> | null = null;
  /** Stored system prompt — fused with first send() to avoid a wasted turn */
  private pendingSystemPrompt: string | null = null;
  private systemPromptSent = false;
  private contextReminder = '';
  /**
   * When the first turn fuses the system prompt, the server echoes back
   * the user message as an item/completed (type=message or agentMessage).
   * We must suppress that echo so the system prompt doesn't leak to the UI.
   * This flag is set true when the fused turn starts, and cleared after
   * the first user-message echo is consumed.
   */
  private suppressNextUserEcho = false;
  /**
   * Accumulates streaming deltas from item/agentMessage/delta.
   * Instead of emitting each token as a separate line (which makes "Salut . Que veux -tu ..."
   * appear word-by-word), we buffer the deltas and let item/completed emit the final text.
   */
  private agentMessageBuffer = '';
  /** Tracks whether we received any deltas for the current agentMessage item.
   *  If true, item/completed should skip emitting text (already covered by deltas). */
  private hadAgentMessageDeltas = false;

  /** Human-readable tag for log messages */
  protected abstract get logTag(): string;
  /** The model to pass in RPC params */
  protected abstract get model(): string;
  /** Extract CLI path from SessionConfig */
  protected abstract getCliPath(config: SessionConfig): string;

  // ── Status & output management ────────────────────────────────────────

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
    this.outputHandlers.forEach((h) => h({
      text, timestamp: Date.now(), type: 'checkpoint',
    }));
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

  setContextReminder(reminder: string) {
    this.contextReminder = reminder;
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

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

    // Spawn the app-server process
    const args = ['app-server'];
    flog.info('AGENT', `${this.logTag}: Spawning: ${this.cliPath} ${args.join(' ')}`);

    this.process = spawn(this.cliPath, args, {
      cwd: this.projectDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
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
        // Non-JSON line — noise from the server
        flog.debug('AGENT', `${this.logTag}: non-JSON stdout: ${line.slice(0, 120)}`);
      }
    });

    // Wire up stderr
    const stderrRl = createInterface({ input: this.process.stderr! });
    this.stderrRl = stderrRl;
    stderrRl.on('line', (line) => {
      if (!line.trim()) return;
      // Reconnection warnings are transient noise
      if (/reconnect/i.test(line) || /stream disconnect/i.test(line) || /connection closed/i.test(line)) {
        flog.warn('AGENT', `${this.logTag} stderr (transient): ${line.slice(0, 200)}`);
        return;
      }
      flog.debug('AGENT', `${this.logTag} stderr: ${line}`);
    });

    this.process.on('exit', (code, signal) => {
      flog.info('AGENT', `${this.logTag}: Process exited (code=${code}, signal=${signal})`);
      this.process = null;
      this.cleanupReadlines();
      // Reject all pending RPC calls
      for (const [id, { reject }] of this.pendingRpc) {
        reject(new Error(`${this.logTag}: process exited (code=${code})`));
        this.pendingRpc.delete(id);
      }
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
      await this.rpcRequest('initialize', {
        clientInfo: { name: 'fedi-cli', version: '1.0.0' },
      });
      this.rpcNotify('initialized', {});
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
        // Resume existing thread
        flog.info('AGENT', `${this.logTag}: Resuming thread ${this.threadId}`);
        await this.rpcRequest('thread/resume', {
          threadId: this.threadId,
        });
        this.systemPromptSent = true;
      } else {
        // Create new thread
        const result = await this.rpcRequest('thread/start', {
          model: this.model,
          cwd: this.projectDir,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        }) as { thread?: { id?: string } };
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
      // Resuming — send a resume message
      this.setStatus('running');
      const resumeMsg = options?.muted
        ? '[Session reprise] Tu es en standby. Attends une tache.'
        : '[Session reprise] Continue ton travail.';
      this.startTurn(resumeMsg);
    } else {
      // First start — store system prompt, fuse with first send()
      this.pendingSystemPrompt = systemPrompt;
      this.setStatus('idle');
      flog.info('AGENT', `${this.logTag}: System prompt stored — will fuse with first send()`);
      this.systemPromptSent = false;
    }
    this.muted = false;
  }

  send(prompt: string) {
    this.stopped = false;
    this.muted = false;
    this.setStatus('running');

    let finalPrompt = prompt;

    // Fuse pending system prompt with first real task
    if (this.pendingSystemPrompt) {
      finalPrompt = `${this.pendingSystemPrompt}\n\n${prompt}`;
      flog.info('AGENT', `${this.logTag}: Fused system prompt with first task`);
      this.pendingSystemPrompt = null;
      this.systemPromptSent = true;
    }

    // The server echoes back the user message as item/completed for EVERY turn — suppress it
    this.suppressNextUserEcho = true;

    // Drain urgent queue
    if (this.urgentQueue.length > 0) {
      const urgentMessages = this.urgentQueue
        .map((m) => `[LIVE MESSAGE DU USER] ${m}`)
        .join('\n\n');
      finalPrompt = `${urgentMessages}\n\n${finalPrompt}`;
      flog.info('AGENT', `${this.logTag}: Drained ${this.urgentQueue.length} urgent messages`);
      this.urgentQueue = [];
    }

    // Prepend context reminder if session was lost
    if (!this.threadId && this.systemPromptSent && this.contextReminder && !this.pendingSystemPrompt) {
      finalPrompt = `${this.contextReminder}\n\n${finalPrompt}`;
      flog.info('AGENT', `${this.logTag}: Session lost — prepending compact context reminder`);
    }

    this.startTurn(finalPrompt);
  }

  sendUrgent(prompt: string) {
    if (this.activeTurnId && this.threadId && this.process?.stdin?.writable) {
      // Turn active — inject immediately via turn/steer
      flog.info('AGENT', `${this.logTag}: Steering active turn with urgent message`);
      this.rpcRequest('turn/steer', {
        threadId: this.threadId,
        input: [{ type: 'text', text: `[LIVE MESSAGE DU USER] ${prompt}` }],
        expectedTurnId: this.activeTurnId,
      }).catch((err) => {
        flog.warn('AGENT', `${this.logTag}: turn/steer failed: ${err}`);
        // Fallback: queue for next send
        this.urgentQueue.push(prompt);
      });
    } else {
      // No active turn — queue for next send()
      this.urgentQueue.push(prompt);
      flog.info('AGENT', `${this.logTag}: Urgent queued (${this.urgentQueue.length} pending): ${prompt.slice(0, 80)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.urgentQueue = [];

    // Interrupt active turn
    if (this.activeTurnId && this.threadId && this.process?.stdin?.writable) {
      try {
        await this.rpcRequest('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        });
      } catch (err) {
        flog.debug('AGENT', `${this.logTag}: turn/interrupt failed (expected during shutdown): ${err}`);
      }
      this.activeTurnId = null;
    }

    // Kill the process
    const proc = this.process;
    if (proc) {
      flog.info('AGENT', `${this.logTag}: Stopping process...`);
      this.cleanupReadlines();
      proc.stdin?.end();
      proc.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
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

    // Reject all pending RPCs
    for (const [id, { reject }] of this.pendingRpc) {
      reject(new Error(`${this.logTag}: stopped`));
      this.pendingRpc.delete(id);
    }

    this.setStatus('stopped');
  }

  // ── Turn management ───────────────────────────────────────────────────

  private startTurn(prompt: string) {
    if (!this.threadId || !this.process?.stdin?.writable) {
      flog.error('AGENT', `${this.logTag}: Cannot start turn — no thread or process`);
      this.emit({ text: `${this.logTag}: processus mort — redemarrage necessaire`, timestamp: Date.now(), type: 'info' });
      this.setStatus('error');
      return;
    }

    // Fire-and-forget RPC — the turn lifecycle is managed via server notifications
    this.rpcRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      model: this.model,
      effort: 'xhigh',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }).catch((err) => {
      flog.error('AGENT', `${this.logTag}: turn/start failed: ${err}`);
      this.emit({ text: `[TURN_FAILED] ${err}`, timestamp: Date.now(), type: 'info' });
      this.setStatus('error');
    });
  }

  // ── JSON-RPC helpers ──────────────────────────────────────────────────

  private rpcRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error(`${this.logTag}: process not writable`));
        return;
      }

      const id = this.rpcId++;
      this.pendingRpc.set(id, { resolve, reject });

      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method,
        id,
        params,
      });

      flog.debug('AGENT', `${this.logTag}: RPC request #${id} ${method}`);
      const ok = this.process.stdin.write(msg + '\n');
      if (!ok) {
        this.process.stdin.once('drain', () => {});
      }

      // Timeout for RPC responses — 30s
      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`${this.logTag}: RPC timeout for ${method} (#${id})`));
        }
      }, 30_000);
    });
  }

  private rpcNotify(method: string, params: Record<string, unknown>) {
    if (!this.process?.stdin?.writable) {
      flog.warn('AGENT', `${this.logTag}: Cannot notify — process not writable`);
      return;
    }

    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    flog.debug('AGENT', `${this.logTag}: RPC notify ${method}`);
    const ok = this.process.stdin.write(msg + '\n');
    if (!ok) {
      this.process.stdin.once('drain', () => {});
    }
  }

  // ── Server message dispatch ───────────────────────────────────────────

  private handleServerMessage(msg: Record<string, unknown>) {
    // RPC response (has 'id' field matching a pending request)
    const msgId = typeof msg.id === 'number' ? msg.id : (typeof msg.id === 'string' ? Number(msg.id) : undefined);
    if (msgId !== undefined && this.pendingRpc.has(msgId) && !msg.method) {
      const pending = this.pendingRpc.get(msgId)!;
      this.pendingRpc.delete(msgId);

      if (msg.error && typeof msg.error === 'object') {
        const err = msg.error as Record<string, unknown>;
        const errMsg = typeof err.message === 'string' ? err.message : 'RPC error';
        pending.reject(new Error(errMsg));
      } else {
        pending.resolve(msg.result ?? null);
      }
      return;
    }

    // Server request or notification (has 'method' field)
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (!method) {
      flog.debug('AGENT', `${this.logTag}: Unknown server message: ${JSON.stringify(msg).slice(0, 200)}`);
      return;
    }

    const params = (msg.params && typeof msg.params === 'object') ? msg.params as Record<string, unknown> : {};

    flog.debug('AGENT', `${this.logTag}: event ${method}`);

    switch (method) {
      case 'turn/started':
        this.handleTurnStarted(params);
        break;
      case 'turn/completed':
        this.handleTurnCompleted(params);
        break;
      case 'item/started':
        this.handleItemStarted(params);
        break;
      case 'item/completed':
        this.handleItemCompleted(params);
        break;
      case 'item/agentMessage/delta':
        this.handleAgentMessageDelta(params);
        break;
      case 'item/commandExecution/outputDelta':
        this.handleCommandOutputDelta(params);
        break;
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.handleRequestApproval(msg);
        break;
      case 'item/tool/requestUserInput':
        this.handleToolUserInput(msg);
        break;
      case 'turn/diff/updated':
      case 'turn/plan/updated':
      case 'item/plan/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/fileChange/outputDelta':
      case 'item/mcpToolCall/progress':
      case 'thread/started':
      case 'thread/status/changed':
      case 'thread/name/updated':
      case 'thread/compacted':
      case 'thread/tokenUsage/updated':
      case 'model/rerouted':
      case 'account/updated':
      case 'account/rateLimits/updated':
      case 'configWarning':
      case 'deprecationNotice':
        flog.debug('AGENT', `${this.logTag}: ${method} (ignored)`);
        break;
      case 'error':
        this.handleError(params);
        break;
      default:
        flog.debug('AGENT', `${this.logTag}: Unhandled notification: ${method}`);
        break;
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────

  private handleTurnStarted(params: Record<string, unknown>) {
    // turn/started params: { threadId, turn: { id, items, status } }
    let turnId: string | undefined;
    if (params.turn && typeof params.turn === 'object') {
      const turn = params.turn as Record<string, unknown>;
      if (typeof turn.id === 'string') turnId = turn.id;
    }
    this.activeTurnId = turnId ?? null;
    if (this.status !== 'running') this.setStatus('running');
    flog.info('AGENT', `${this.logTag}: Turn started: ${turnId ?? 'unknown'}`);
  }

  private handleTurnCompleted(_params: Record<string, unknown>) {
    this.activeTurnId = null;
    this.emitCheckpoint(`[CODEX:done] Turn completed`);
    this.setStatus('waiting');
    flog.info('AGENT', `${this.logTag}: Turn completed`);
  }

  private handleItemStarted(params: Record<string, unknown>) {
    const item = (params.item && typeof params.item === 'object') ? params.item as Record<string, unknown> : params;
    const itemType = typeof item.type === 'string' ? item.type : undefined;

    if (itemType === 'commandExecution') {
      // Only emit checkpoint on start — the system action line is emitted on item/completed (with exit code)
      const command = typeof item.command === 'string' ? item.command : undefined;
      if (command) {
        const formatted = formatAction('bash', command);
        if (formatted) this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
        this.emitCheckpoint(`[CODEX:checkpoint] Running: ${command.slice(0, 100)}`);
      }
    } else if (itemType === 'fileChange' || itemType === 'file_change') {
      // Only emit checkpoint on start — the system action line is emitted on item/completed
      if (Array.isArray(item.changes)) {
        for (const change of item.changes as Array<Record<string, unknown>>) {
          const file = typeof change.path === 'string' ? change.path
            : typeof change.filename === 'string' ? change.filename : undefined;
          const kind = typeof change.kind === 'string' ? change.kind : undefined;
          if (file) {
            this.emitCheckpoint(`[CODEX:checkpoint] File ${kind ?? 'change'}: ${file}`);
          }
        }
      }
    } else if (itemType === 'fileRead' || itemType === 'file_read' || itemType === 'read_file') {
      // Only emit checkpoint on start — the system action line is emitted on item/completed
      const filename = typeof item.filename === 'string' ? item.filename
        : typeof item.path === 'string' ? item.path : undefined;
      if (filename) {
        this.emitCheckpoint(`[CODEX:checkpoint] Reading: ${filename}`);
      }
    }
    // agentMessage items — reset delta buffer for new item
    if (itemType === 'agent_message' || itemType === 'agentMessage' || itemType === 'message' || itemType === 'output_message') {
      this.agentMessageBuffer = '';
      this.hadAgentMessageDeltas = false;
    }
  }

  private handleItemCompleted(params: Record<string, unknown>) {
    const item = (params.item && typeof params.item === 'object') ? params.item as Record<string, unknown> : params;
    const itemType = typeof item.type === 'string' ? item.type : undefined;
    const itemStatus = typeof item.status === 'string' ? item.status : undefined;

    // Reasoning — log only
    if (itemType === 'reasoning') {
      if (typeof item.text === 'string') flog.debug('AGENT', `${this.logTag} reasoning: ${item.text.slice(0, 120)}`);
      return;
    }

    // User message echo — suppress (the server echoes back user input messages)
    const role = typeof item.role === 'string' ? item.role : undefined;
    if (role === 'user') {
      flog.debug('AGENT', `${this.logTag}: Suppressed user message echo`);
      return;
    }

    // Agent message — final text
    if (itemType === 'agent_message' || itemType === 'agentMessage') {
      // Suppress the first echo of the fused system prompt + task
      if (this.suppressNextUserEcho) {
        this.suppressNextUserEcho = false;
        this.agentMessageBuffer = '';
        this.hadAgentMessageDeltas = false;
        flog.debug('AGENT', `${this.logTag}: Suppressed user-message echo (fused system prompt)`);
        return;
      }
      // Use buffered deltas if available, otherwise extract from item
      const text = this.hadAgentMessageDeltas
        ? this.agentMessageBuffer.trim()
        : this.extractText(item);
      this.agentMessageBuffer = '';
      this.hadAgentMessageDeltas = false;
      if (text) {
        this.emit({ text, timestamp: Date.now(), type: 'stdout' });
      }
      return;
    }

    // OpenAI Responses API message types
    if (itemType === 'message' || itemType === 'output_message') {
      // Suppress the first echo of the fused system prompt + task
      if (this.suppressNextUserEcho) {
        this.suppressNextUserEcho = false;
        this.agentMessageBuffer = '';
        this.hadAgentMessageDeltas = false;
        flog.debug('AGENT', `${this.logTag}: Suppressed user-message echo (fused system prompt)`);
        return;
      }
      // Use buffered deltas if available, otherwise extract from item
      const text = this.hadAgentMessageDeltas
        ? this.agentMessageBuffer.trim()
        : this.extractText(item);
      this.agentMessageBuffer = '';
      this.hadAgentMessageDeltas = false;
      if (text) {
        this.emit({ text, timestamp: Date.now(), type: 'stdout' });
      }
      return;
    }

    // Command execution completed — show exit code
    if (itemType === 'commandExecution' || itemType === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : undefined;
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode
        : typeof item.exit_code === 'number' ? item.exit_code : undefined;
      if (command) {
        const formatted = formatAction('bash', command);
        if (formatted) {
          const suffix = exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode})` : '';
          this.emit({ text: `${formatted}${suffix}`, timestamp: Date.now(), type: 'system' });
        }
        if (exitCode !== undefined && exitCode !== 0) {
          const stderr = typeof item.stderr === 'string' ? item.stderr : undefined;
          if (stderr) {
            const short = stderr.length > 200 ? stderr.slice(0, 200) + '...' : stderr;
            this.emit({ text: short, timestamp: Date.now(), type: 'info' });
          }
        }
        this.emitCheckpoint(`[CODEX:checkpoint] Command: ${command.slice(0, 100)}${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`);
      }
      return;
    }

    // File change completed — changes: [{ path, kind, diff }]
    if (itemType === 'fileChange' || itemType === 'file_change') {
      if (Array.isArray(item.changes)) {
        for (const change of item.changes as Array<Record<string, unknown>>) {
          const file = typeof change.path === 'string' ? change.path
            : typeof change.filename === 'string' ? change.filename : undefined;
          const kind = typeof change.kind === 'string' ? change.kind : undefined;
          if (file) {
            const label = kind === 'add' ? 'create' : kind === 'delete' ? 'delete' : 'edit';
            const formatted = formatAction(label, file);
            if (formatted) {
              const suffix = itemStatus && itemStatus !== 'completed' ? ` (${itemStatus})` : '';
              this.emit({ text: `${formatted}${suffix}`, timestamp: Date.now(), type: 'system' });
            }
            this.emitCheckpoint(`[CODEX:checkpoint] File ${kind ?? 'change'}: ${file}`);
          }
        }
      }
      return;
    }

    // File read completed
    if (itemType === 'fileRead' || itemType === 'file_read' || itemType === 'read_file') {
      const filename = typeof item.filename === 'string' ? item.filename
        : typeof item.path === 'string' ? item.path : undefined;
      if (filename) {
        const formatted = formatAction('read', filename);
        if (formatted) this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
        this.emitCheckpoint(`[CODEX:checkpoint] Read: ${filename}`);
      }
      return;
    }

    // Generic content array — but not if we're suppressing a user echo
    if (Array.isArray(item.content)) {
      if (this.suppressNextUserEcho) {
        this.suppressNextUserEcho = false;
        flog.debug('AGENT', `${this.logTag}: Suppressed user-message echo (content array, fused system prompt)`);
        return;
      }
      for (const block of item.content as Array<Record<string, unknown>>) {
        if (typeof block.text === 'string') {
          this.emit({ text: block.text, timestamp: Date.now(), type: 'stdout' });
        }
      }
      return;
    }

    // Catch-all text extraction — but not if we're suppressing a user echo
    if (this.suppressNextUserEcho) {
      this.suppressNextUserEcho = false;
      flog.debug('AGENT', `${this.logTag}: Suppressed user-message echo (catch-all, fused system prompt)`);
      return;
    }
    const fallbackText = this.extractText(item);
    if (fallbackText) {
      this.emit({ text: fallbackText, timestamp: Date.now(), type: 'stdout' });
    } else {
      flog.debug('AGENT', `${this.logTag}: item/completed type="${itemType}" — no text extracted. Keys: ${Object.keys(item).join(', ')}`);
    }
  }

  private handleAgentMessageDelta(params: Record<string, unknown>) {
    const delta = typeof params.delta === 'string' ? params.delta : undefined;
    if (delta) {
      // Buffer deltas instead of emitting each token as a separate line.
      // The full text will be emitted by item/completed.
      this.agentMessageBuffer += delta;
      this.hadAgentMessageDeltas = true;
    }
  }

  private handleCommandOutputDelta(params: Record<string, unknown>) {
    const delta = typeof params.delta === 'string' ? params.delta : undefined;
    if (delta) {
      flog.debug('AGENT', `${this.logTag}: command output: ${delta.slice(0, 120)}`);
    }
  }

  private handleRequestApproval(msg: Record<string, unknown>) {
    // Auto-accept all approvals (full-auto mode)
    const id = typeof msg.id === 'number' ? msg.id : undefined;
    if (id !== undefined) {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { decision: 'accept' },
      });
      if (this.process?.stdin?.writable) {
        this.process.stdin.write(response + '\n');
        flog.debug('AGENT', `${this.logTag}: Auto-accepted approval request #${id}`);
      }
    } else {
      flog.warn('AGENT', `${this.logTag}: Approval request without id — cannot respond`);
    }
  }

  private handleToolUserInput(msg: Record<string, unknown>) {
    // Auto-respond to tool user input requests (decline — we can't collect user input)
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

  private handleError(params: Record<string, unknown>) {
    // error notification: { error: { message, codexErrorInfo?, additionalDetails? }, threadId, turnId, willRetry }
    let errorMsg = 'Unknown error';
    if (params.error && typeof params.error === 'object') {
      const err = params.error as Record<string, unknown>;
      if (typeof err.message === 'string') errorMsg = err.message;
    } else if (typeof params.message === 'string') {
      errorMsg = params.message;
    } else if (typeof params.error === 'string') {
      errorMsg = params.error;
    }
    const willRetry = typeof params.willRetry === 'boolean' ? params.willRetry : false;

    // Transient reconnection warnings — ignore
    if (/reconnect/i.test(errorMsg) || /stream disconnect/i.test(errorMsg) || /connection closed/i.test(errorMsg)) {
      flog.warn('AGENT', `${this.logTag}: Transient warning (non-fatal): ${errorMsg}`);
      return;
    }

    if (willRetry) {
      flog.warn('AGENT', `${this.logTag}: Error (will retry): ${errorMsg}`);
      this.emit({ text: `Codex: ${errorMsg} (retry en cours...)`, timestamp: Date.now(), type: 'info' });
      return;
    }

    flog.error('AGENT', `${this.logTag}: Error: ${errorMsg}`);
    this.lastError = errorMsg;
    this.emit({ text: `Codex error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
    this.setStatus('error');
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Try to extract text from various item shapes */
  private extractText(item: Record<string, unknown>): string | undefined {
    // Content array
    if (Array.isArray(item.content)) {
      const texts: string[] = [];
      for (const block of item.content as Array<Record<string, unknown>>) {
        if (typeof block.text === 'string') texts.push(block.text);
      }
      if (texts.length > 0) return texts.join('\n');
    }
    // Output array
    if (Array.isArray(item.output)) {
      const texts: string[] = [];
      for (const block of item.output as Array<Record<string, unknown>>) {
        if (typeof block.text === 'string') texts.push(block.text);
      }
      if (texts.length > 0) return texts.join('\n');
    }
    // Direct text
    if (typeof item.text === 'string' && item.text.trim()) return item.text;
    // Output string
    if (typeof item.output === 'string' && item.output.trim()) return item.output;
    return undefined;
  }

  private cleanupReadlines() {
    if (this.stdoutRl) {
      this.stdoutRl.removeAllListeners();
      try { this.stdoutRl.close(); } catch { /* ignore */ }
      this.stdoutRl = null;
    }
    if (this.stderrRl) {
      this.stderrRl.removeAllListeners();
      try { this.stderrRl.close(); } catch { /* ignore */ }
      this.stderrRl = null;
    }
  }
}
