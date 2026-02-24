import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, AgentStatus, OutputLine, SessionConfig } from './types.js';
import { logger } from '../utils/logger.js';
import { formatAction } from '../utils/format-action.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

export class GeminiAgent implements AgentProcess {
  readonly id = 'gemini' as const;
  status: AgentStatus = 'idle';
  private sessionId: string | null = null;
  private projectDir: string = '';
  private cliPath: string = 'gemini';
  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private pendingText: string = '';
  private lastError: string | null = null;

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
    this.cliPath = config.geminiPath;

    this.setStatus('running');

    const fullPrompt = systemPrompt;
    await this.execWithRetry(fullPrompt);
  }

  send(prompt: string) {
    this.setStatus('running');
    this.execWithRetry(prompt).catch((err) => {
      logger.error(`[GEMINI] exec error: ${err}`);
      this.setStatus('error');
    });
  }

  private async execWithRetry(prompt: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      this.lastError = null;
      const result = await this.exec(prompt);

      // If we got an API capacity error, retry
      const err = this.lastError as string | null;
      if (err !== null && err.includes('capacity') && attempt < MAX_RETRIES) {
        logger.warn(`[GEMINI] Capacity error, retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`);
        this.emit({ text: `API surchargee, retry ${attempt}/${MAX_RETRIES}...`, timestamp: Date.now(), type: 'system' });
        this.setStatus('running');
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      return result;
    }
    return '';
  }

  private async exec(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = [];

      if (this.sessionId) {
        args.push('--resume', this.sessionId);
      }

      args.push(
        '--prompt', prompt,
        '--output-format', 'stream-json',
        '--model', 'gemini-2.5-flash',
      );

      logger.info(`[GEMINI] Spawning: ${this.cliPath} (prompt: ${prompt.slice(0, 80)})`);

      this.pendingText = '';

      const proc = spawn(this.cliPath, args, {
        cwd: this.projectDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcess = proc;
      let fullStdout = '';

      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        fullStdout += line + '\n';
        try {
          const event = JSON.parse(line);
          this.handleStreamEvent(event);
        } catch {
          this.emit({ text: line, timestamp: Date.now(), type: 'stdout' });
        }
      });

      let stderrBuf = '';
      const stderrRl = createInterface({ input: proc.stderr! });
      stderrRl.on('line', (line) => {
        if (!line.trim()) return;
        logger.debug(`[GEMINI stderr] ${line}`);
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        // Skip noise: stack traces, info messages
        if (clean.startsWith('at ') || clean.startsWith('Loaded ') || clean.startsWith('Session cleanup')) return;
        // Capture meaningful stderr for error reporting
        if (stderrBuf.length < 500) {
          stderrBuf += (stderrBuf ? ' | ' : '') + clean;
        }
      });

      proc.on('error', (err) => {
        logger.error(`[GEMINI] Process error: ${err.message}`);
        this.emit({ text: `Erreur: ${err.message}`, timestamp: Date.now(), type: 'system' });
        this.setStatus('error');
        this.activeProcess = null;
        reject(err);
      });

      proc.on('exit', (code) => {
        logger.info(`[GEMINI] Process exited with code ${code}`);
        this.activeProcess = null;

        // Emit any accumulated text
        if (this.pendingText) {
          this.emit({ text: this.pendingText, timestamp: Date.now(), type: 'stdout' });
          this.emit({ text: this.pendingText, timestamp: Date.now(), type: 'relay' });
          this.pendingText = '';
        }

        // Handle non-zero exit with no output — show error to user
        if (code !== 0 && !fullStdout.trim()) {
          const detail = stderrBuf || `exit code ${code}`;
          const errMsg = `Gemini CLI error: ${detail}`;
          logger.error(`[GEMINI] ${errMsg}`);
          this.lastError = errMsg;
          this.emit({ text: errMsg, timestamp: Date.now(), type: 'system' });
          this.setStatus('error');
          resolve('');
          return;
        }

        // If process exited normally but produced no visible output
        if (!fullStdout.trim()) {
          logger.warn('[GEMINI] Process exited with no output');
          this.emit({ text: 'Gemini returned empty response. Try again.', timestamp: Date.now(), type: 'system' });
        }

        this.setStatus('waiting');
        resolve(fullStdout);
      });
    });
  }

  private handleStreamEvent(event: Record<string, unknown>) {
    const eventType = event.type as string | undefined;
    logger.debug(`[GEMINI event] ${eventType} ${JSON.stringify(event).slice(0, 200)}`);

    if (eventType === 'init' && event.session_id) {
      this.sessionId = event.session_id as string;
      logger.info(`[GEMINI] Session ID: ${this.sessionId}`);
    }

    if (eventType === 'message' && event.role === 'assistant' && event.content) {
      const text = event.content as string;
      this.pendingText += text;
      // Don't emit streaming chunks — they break markdown parsing.
      // The full text is emitted on 'result' event for correct rendering.
    }

    if (eventType === 'tool_use') {
      const toolName = event.tool_name as string | undefined;
      const params = event.parameters as Record<string, unknown> | undefined;
      if (toolName) {
        const filePath = (params?.file_path ?? params?.dir_path ?? params?.path) as string | undefined;
        const detail = filePath || (params?.pattern as string | undefined) || '';
        const formatted = formatAction(toolName, detail);
        if (formatted) this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
      }
    }

    if (eventType === 'result') {
      // Check for API errors
      const error = event.error as Record<string, unknown> | undefined;
      if (error?.message) {
        const errMsg = error.message as string;
        this.lastError = errMsg;
        logger.error(`[GEMINI] API error: ${errMsg}`);
        this.emit({ text: `Gemini: ${errMsg}`, timestamp: Date.now(), type: 'system' });
      }

      if (this.pendingText) {
        // Emit full text as stdout so markdown is parsed correctly on complete text
        this.emit({ text: this.pendingText, timestamp: Date.now(), type: 'stdout' });
        // Also emit as relay for the orchestrator relay pattern detection
        this.emit({ text: this.pendingText, timestamp: Date.now(), type: 'relay' });
        this.pendingText = '';
      }
      this.setStatus('waiting');
    }
  }

  async stop(): Promise<void> {
    if (this.activeProcess) {
      logger.info('[GEMINI] Stopping active process...');
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
