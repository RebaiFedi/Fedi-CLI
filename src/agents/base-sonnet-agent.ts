import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentId, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { flog } from '../utils/log.js';
import { formatAction } from '../utils/format-action.js';
import { loadUserConfig } from '../config/user-config.js';
import { parseMessageWithImages, type ContentBlock } from '../utils/image-utils.js';

export abstract class BaseSonnetAgent implements AgentProcess {
  abstract readonly id: AgentId;
  status: AgentStatus = 'idle';
  lastError: string | null = null;
  protected process: ChildProcess | null = null;
  protected sessionId: string | null = null;
  protected cliPath: string = 'claude';
  protected outputHandlers: Array<(line: OutputLine) => void> = [];
  protected statusHandlers: Array<(status: AgentStatus) => void> = [];
  private stdoutRl: ReturnType<typeof createInterface> | null = null;
  private stderrRl: ReturnType<typeof createInterface> | null = null;
  private procExitHandler: ((code: number | null) => void) | null = null;
  private procErrorHandler: ((err: Error) => void) | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private sendAborted = false;
  private lastDeadWarning = 0;

  /** Human-readable agent name for log messages */
  protected abstract get logTag(): string;
  /** The model flag passed to the CLI */
  protected abstract get model(): string;
  /** Effort level: 'high' | 'medium' | 'low' */
  protected abstract get effort(): string;
  /** Whether thinking (extended thinking) is enabled */
  protected abstract get thinking(): boolean;
  /** Extra spawn args appended after model args. Receives systemPrompt for agents that need --system-prompt flag. */
  protected getExtraArgs(_systemPrompt: string): string[] {
    return [];
  }

  protected setStatus(s: AgentStatus, notify = true) {
    this.status = s;
    if (!notify) return;
    this.statusHandlers.forEach((h) => h(s));
  }

  protected emit(line: OutputLine) {
    this.outputHandlers.forEach((h) => h(line));
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

  /** Clean up process-level I/O handlers (readline, exit, error). */
  protected clearProcessHandlers() {
    if (this.stdoutRl) {
      this.stdoutRl.removeAllListeners();
      try {
        this.stdoutRl.close();
      } catch (err) {
        flog.debug(
          'AGENT',
          `${this.logTag}: stdout readline close ignored: ${String(err).slice(0, 120)}`,
        );
      }
      this.stdoutRl = null;
    }
    if (this.stderrRl) {
      this.stderrRl.removeAllListeners();
      try {
        this.stderrRl.close();
      } catch (err) {
        flog.debug(
          'AGENT',
          `${this.logTag}: stderr readline close ignored: ${String(err).slice(0, 120)}`,
        );
      }
      this.stderrRl = null;
    }
    if (this.process && this.procExitHandler) {
      this.process.off('exit', this.procExitHandler);
    }
    if (this.process && this.procErrorHandler) {
      this.process.off('error', this.procErrorHandler);
    }
    this.procExitHandler = null;
    this.procErrorHandler = null;
  }

  async start(
    config: SessionConfig,
    systemPrompt: string,
    options?: { muted?: boolean; prewarm?: boolean },
  ): Promise<void> {
    if (this.process) {
      flog.warn('AGENT', `${this.logTag}: Already running, stopping first`);
      await this.stop();
    }
    this.sendAborted = false;
    this.sendChain = Promise.resolve();

    this.cliPath = config.claudePath;

    const args = [
      '-p',
      '--model',
      this.model,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--effort',
      this.effort,
    ];

    // Only skip permissions in unsafe mode
    if (!loadUserConfig().sandboxMode) {
      args.push('--dangerously-skip-permissions');
    }

    // Resume existing session if available (preserves conversation history)
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      flog.info('AGENT', `${this.logTag}: Resuming session ${this.sessionId}`);
    }

    args.push(...this.getExtraArgs(systemPrompt));

    flog.info('AGENT', `${this.logTag}: Spawning: ${this.cliPath} ${args.join(' ')}`);

    this.process = spawn(this.cliPath, args, {
      cwd: config.projectDir,
      env: {
        ...process.env,
        // Increase output token limit to avoid "exceeded 32000 output token maximum"
        // errors that cause long delays during large file generation.
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '128000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Create new process group so we can kill the entire tree on stop
      detached: true,
    });

    // Prewarm mode: spawn the process but don't send any message.
    // Status stays idle (no spinner). I/O handlers attached so process doesn't hang.
    if (options?.prewarm) {
      this.attachIOHandlers();
      flog.info('AGENT', `${this.logTag}: Process pre-spawned (no message sent)`);
      return;
    }

    this.setStatus('running');
    this.attachIOHandlers();

    // When resuming a session, the CLI already has the conversation history.
    // Don't re-send the system prompt — it would be redundant.
    if (!this.sessionId) {
      await this.sendInitialMessage(systemPrompt);
    } else {
      flog.info('AGENT', `${this.logTag}: Skipping initial message (resumed session)`);
    }
  }

  /** Attach stdout/stderr/exit/error handlers to the spawned process. */
  private attachIOHandlers(): void {
    if (!this.process) return;

    const rl = createInterface({ input: this.process.stdout! });
    this.stdoutRl = rl;
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
    this.stderrRl = stderrRl;
    stderrRl.on('line', (line) => {
      if (!line.trim()) return;
      flog.debug('AGENT', `${this.logTag} stderr: ${line}`);
    });

    this.procExitHandler = (code) => {
      flog.info('AGENT', `${this.logTag}: Process exited with code ${code}`);
      this.setStatus('stopped');
      this.process = null;
      this.clearProcessHandlers();
    };
    this.process.on('exit', this.procExitHandler);

    this.procErrorHandler = (err) => {
      flog.error('AGENT', `${this.logTag}: Process error: ${err.message}`);
      this.emit({ text: `Error: ${err.message}`, timestamp: Date.now(), type: 'system' });
      this.setStatus('error');
    };
    this.process.on('error', this.procErrorHandler);
  }

  /** Send the first message after spawn. Override to customize (e.g., mute response). */
  protected async sendInitialMessage(systemPrompt: string) {
    const imageBlocks = await parseMessageWithImages(systemPrompt);
    const content: string | ContentBlock[] = imageBlocks ?? systemPrompt;

    await this.sendRaw({
      type: 'user',
      message: { role: 'user', content },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
  }

  protected handleStreamMessage(msg: Record<string, unknown>) {
    const type = typeof msg.type === 'string' ? msg.type : '';
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;
    flog.debug('AGENT', `${this.logTag} event: ${type} ${subtype ?? ''}`);

    const emitAssistantText = (text: string) => {
      if (!text) return;
      if (this.status !== 'running') this.setStatus('running');
      this.emit({ text, timestamp: Date.now(), type: 'stdout' });
    };

    if (type === 'system' && typeof msg.session_id === 'string') {
      this.sessionId = msg.session_id;
      flog.info('AGENT', `${this.logTag}: Session ID: ${this.sessionId}`);
    }

    if (type === 'system' && subtype === 'conversation_compacted') {
      flog.warn('AGENT', `${this.logTag}: Context window compacted`);
      const prevStatus = this.status;
      this.setStatus('compacting');
      // Log only — no UI emit. The status badge already shows compacting state.
      this.setStatus(prevStatus === 'compacting' ? 'running' : prevStatus);
    }

    if (type === 'result' && msg.is_error) {
      const errorMsg = typeof msg.result === 'string' ? msg.result : 'Unknown error';
      const subType = typeof msg.subtype === 'string' ? msg.subtype : '';
      this.lastError = errorMsg;
      flog.error('AGENT', `${this.logTag}: Result error: ${errorMsg} (subtype=${subType})`);

      // If the error happened during a resumed session, the session is likely
      // corrupted from the previous interruption. Clear the sessionId so the
      // next start() creates a fresh session instead of resuming again.
      if (
        this.sessionId &&
        (subType === 'error_during_execution' || errorMsg === 'Unknown error')
      ) {
        flog.warn(
          'AGENT',
          `${this.logTag}: Clearing corrupted session ${this.sessionId} — next start will be fresh`,
        );
        this.sessionId = null;
      }

      // Detect quota/usage limit errors and show user-friendly message.
      const isQuotaError =
        /(out of extra usage|rate limit|hit your limit|usage limit|quota)/i.test(errorMsg);
      if (isQuotaError) {
        const resetMatch = errorMsg.match(
          /resets?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*\([^)]+\))?)/i,
        );
        const resetInfo = resetMatch ? ` (reset: ${resetMatch[1]})` : '';
        this.emit({
          text: `${this.logTag}: quota epuise${resetInfo}. ${errorMsg}`,
          timestamp: Date.now(),
          type: 'info',
        });
      } else {
        this.emit({
          text: `${this.logTag} error: ${errorMsg}`,
          timestamp: Date.now(),
          type: 'info',
        });
      }

      // Keep status coherent for all result errors.
      this.setStatus('error');
    }

    // Compatibility: some stream-json variants emit text deltas directly.
    if (
      (type === 'assistant_delta' || type === 'message_delta' || type === 'content_block_delta') &&
      typeof msg.delta === 'string'
    ) {
      emitAssistantText(msg.delta);
    }

    if (type === 'assistant' && msg.message && typeof msg.message === 'object') {
      const message = msg.message as Record<string, unknown>;
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && typeof block === 'object') {
            if (block.type === 'text' && typeof block.text === 'string') {
              emitAssistantText(block.text);
            }
            if (block.type === 'tool_use') {
              const toolName = typeof block.name === 'string' ? block.name : 'tool';
              const input =
                block.input && typeof block.input === 'object'
                  ? (block.input as Record<string, unknown>)
                  : undefined;
              this.emitToolAction(toolName, input);
            }
          }
        }
      }
    }

    if ((type === 'message' || type === 'output_message') && msg.message && typeof msg.message === 'object') {
      const message = msg.message as Record<string, unknown>;
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            emitAssistantText(block.text);
          }
        }
      }
    }

    if (type === 'result') {
      // Don't reset to 'waiting' if this result was an error — preserve error status
      if (!msg.is_error) {
        this.onResult();
      }
    }
  }

  /** Called when a 'result' event is received. Override to add behavior (e.g., unmute). */
  protected onResult() {
    this.setStatus('waiting');
  }

  protected emitToolAction(toolName: string, input?: Record<string, unknown>) {
    const str = (key: string): string | undefined => {
      const v = input?.[key];
      return typeof v === 'string' ? v : undefined;
    };

    let detail: string | undefined;
    switch (toolName) {
      case 'Read':
      case 'Write':
      case 'Edit':
        detail = str('file_path');
        break;
      case 'Bash':
        detail = str('command');
        break;
      case 'Glob':
      case 'Grep':
        detail = str('pattern');
        break;
      default:
        detail = undefined;
    }
    const formatted = formatAction(toolName, detail);
    if (formatted) {
      // Build rich tool metadata
      const toolMap: Record<string, import('./types.js').ToolAction> = {
        Read: 'read',
        Write: 'write',
        Edit: 'edit',
        Bash: 'bash',
        Glob: 'glob',
        Grep: 'grep',
        WebFetch: 'fetch',
        Agent: 'agent',
        TodoWrite: 'todo',
      };
      const tool = toolMap[toolName];
      if (tool) {
        const meta: import('./types.js').ToolMeta = { tool };
        if (detail && (tool === 'read' || tool === 'write' || tool === 'edit')) {
          meta.file = detail;
        }
        if (tool === 'bash' && detail) meta.command = detail;
        if ((tool === 'glob' || tool === 'grep') && detail) meta.pattern = detail;
        // Capture Edit diff content
        if (tool === 'edit') {
          const oldStr = str('old_string');
          const newStr = str('new_string');
          if (oldStr) meta.oldLines = oldStr.split('\n');
          if (newStr) meta.newLines = newStr.split('\n');
        }
        // Capture Write/Create content preview
        if (tool === 'write') {
          const content = str('content');
          if (content) {
            meta.newLines = content.split('\n');
          }
        }
        this.emit({ text: formatted, timestamp: Date.now(), type: 'system', toolMeta: meta });
      } else {
        this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
      }
    }
  }

  send(prompt: string) {
    if (!this.process?.stdin?.writable) {
      const now = Date.now();
      if (now - this.lastDeadWarning < 5000) return; // throttle: 1 warning per 5s
      this.lastDeadWarning = now;
      flog.error('AGENT', `${this.logTag}: Cannot send: process not running`);
      this.lastError = 'process not running';
      this.setStatus('error');
      this.emit({
        text: `${this.logTag}: processus mort — redemarrage necessaire`,
        timestamp: Date.now(),
        type: 'info',
      });
      return;
    }
    this.setStatus('running');

    this.sendWithImages(prompt);
  }

  /** Inject a message directly into stdin WITHOUT changing agent status.
   *  Used for LIVE user messages and cross-talk while the agent is already running. */
  sendUrgent(prompt: string) {
    if (!this.process?.stdin?.writable) {
      flog.warn('AGENT', `${this.logTag}: Cannot sendUrgent: process not running`);
      return;
    }
    this.sendWithImages(prompt);
  }

  /** Internal: resolve images (async) then send the message */
  private sendWithImages(prompt: string) {
    this.sendChain = this.sendChain
      .then(async () => {
        if (this.sendAborted) return;
        try {
          const imageBlocks = await parseMessageWithImages(prompt);
          if (this.sendAborted) return;
          const content: string | ContentBlock[] = imageBlocks ?? prompt;
          await this.sendRaw({
            type: 'user',
            message: { role: 'user', content },
            ...(this.sessionId ? { session_id: this.sessionId } : {}),
          });
        } catch (err) {
          flog.error('AGENT', `${this.logTag}: Image parsing failed: ${err}`);
          if (this.sendAborted) return;
          // Fall back to text-only
          await this.sendRaw({
            type: 'user',
            message: { role: 'user', content: prompt },
            ...(this.sessionId ? { session_id: this.sessionId } : {}),
          });
        }
      })
      .catch((err) => {
        flog.error(
          'AGENT',
          `${this.logTag}: sendWithImages queue failed: ${String(err).slice(0, 120)}`,
        );
      });
  }

  /** Remove unpaired Unicode surrogates that cause JSON encoding errors.
   *  Replaces lone surrogates (U+D800..U+DFFF) with the Unicode replacement character. */
  private sanitizeUnicode(text: string): string {
    return text.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
  }

  protected async sendRaw(obj: Record<string, unknown>) {
    const stdin = this.process?.stdin;
    if (!stdin?.writable || this.sendAborted) return;
    const json = this.sanitizeUnicode(JSON.stringify(obj));
    flog.debug('AGENT', `${this.logTag}: Sending: ${json.slice(0, 200)}`);
    const ok = stdin.write(json + '\n');
    if (!ok) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          flog.warn('AGENT', `${this.logTag}: stdin drain timeout (5s) — continuing`);
          stdin.removeListener('drain', onDrain);
          resolve();
        }, 5000);
        const onDrain = () => {
          clearTimeout(timeout);
          resolve();
        };
        stdin.once('drain', onDrain);
      });
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async stop(): Promise<void> {
    this.sendAborted = true;
    this.sendChain = Promise.resolve();
    const proc = this.process;
    if (!proc) {
      this.clearProcessHandlers();
      this.setStatus('stopped');
      return;
    }

    flog.info('AGENT', `${this.logTag}: Stopping...`);
    this.clearProcessHandlers();
    proc.stdin?.end();

    // Kill the entire process group (detached: true gives each agent its own group).
    // This ensures claude's sub-processes (subagents, tools) are also terminated.
    this.killProcessGroup(proc, 'SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.killProcessGroup(proc, 'SIGKILL');
        flog.warn('AGENT', `${this.logTag}: Force killing after 3s`);
        resolve();
      }, 3000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this.clearProcessHandlers();
    this.setStatus('stopped');
  }

  /** Kill the process and its entire process group. */
  private killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
    try {
      // Kill the process group (negative PID) — kills the main process + all children.
      // Negative PID is only supported on POSIX platforms (Linux, macOS).
      if (proc.pid && process.platform !== 'win32') {
        process.kill(-proc.pid, signal);
      } else if (proc.pid) {
        proc.kill(signal);
      }
    } catch {
      // Group kill failed — fall back to direct kill
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
}
