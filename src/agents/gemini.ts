import type { SessionConfig } from './types.js';
import { BaseExecAgent } from './base-exec-agent.js';
import { flog } from '../utils/log.js';
import { formatAction } from '../utils/format-action.js';

export class GeminiAgent extends BaseExecAgent {
  readonly id = 'gemini' as const;

  /** Last API error message — included in auto-relay placeholder so Opus knows why */
  lastError: string | null = null;

  /** Consecutive 429/capacity failures — used for exponential backoff */
  private consecutiveFailures = 0;
  private static readonly MAX_RETRIES = 2;
  private static readonly BASE_BACKOFF_MS = 2_000;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  protected get logTag() { return '[GEMINI]'; }

  protected getCliPath(config: SessionConfig): string {
    return config.geminiPath || 'gemini';
  }

  protected buildArgs(prompt: string): string[] {
    const args: string[] = [];

    args.push('-p', prompt);
    args.push('-o', 'stream-json');
    args.push('-m', 'gemini-2.5-pro');
    args.push('--approval-mode', 'auto_edit');

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    return args;
  }

  protected handleStreamEvent(event: Record<string, unknown>) {
    const eventType = typeof event.type === 'string' ? event.type : undefined;
    flog.debug('AGENT', `[GEMINI event] ${eventType}`);
    // Clear lastError and reset failure counter on any successful event
    if (eventType && eventType !== 'error') {
      this.lastError = null;
      this.consecutiveFailures = 0;
    }

    // init event -> capture session_id
    if (eventType === 'init' && typeof event.session_id === 'string') {
      this.sessionId = event.session_id;
      flog.info('AGENT', `[GEMINI] Session ID: ${this.sessionId}`);
      return;
    }

    // message event (role=assistant) -> extract text content
    if (eventType === 'message') {
      const role = typeof event.role === 'string' ? event.role : undefined;
      if (role === 'assistant') {
        const content = event.content;
        if (typeof content === 'string' && content.trim()) {
          this.emit({ text: content, timestamp: Date.now(), type: 'stdout' });
        } else if (Array.isArray(content)) {
          for (const part of content as Array<Record<string, unknown>>) {
            if (typeof part.text === 'string' && part.text.trim()) {
              this.emit({ text: part.text, timestamp: Date.now(), type: 'stdout' });
            }
          }
        }
      }
      return;
    }

    // toolCall / tool_use event -> show action
    if (eventType === 'toolCall' || eventType === 'tool_use') {
      const toolObj = event.tool && typeof event.tool === 'object' ? event.tool as Record<string, unknown> : undefined;
      const name = (
        typeof event.name === 'string' ? event.name
        : typeof event.tool_name === 'string' ? event.tool_name
        : typeof toolObj?.name === 'string' ? toolObj.name
        : undefined
      ) as string | undefined;
      const args = (
        event.args && typeof event.args === 'object' ? event.args
        : event.input && typeof event.input === 'object' ? event.input
        : toolObj?.args && typeof toolObj.args === 'object' ? toolObj.args
        : undefined
      ) as Record<string, unknown> | undefined;

      flog.debug('AGENT', `[GEMINI tool] name=${name}, keys=${Object.keys(event).join(',')}`);

      if (name) {
        let actionText: string | null = null;
        const str = (key: string) => typeof args?.[key] === 'string' ? args[key] as string : undefined;

        if (name === 'readFile' || name === 'read_file') {
          actionText = formatAction('read', str('path') ?? str('filename') ?? name);
        } else if (name === 'listFiles' || name === 'list_files' || name === 'glob') {
          actionText = formatAction('glob', str('pattern') ?? str('path') ?? '.');
        } else if (name === 'grep' || name === 'search') {
          actionText = formatAction('grep', str('query') ?? str('pattern') ?? name);
        } else if (name === 'runShell' || name === 'shell' || name === 'bash') {
          actionText = formatAction('bash', str('command') ?? str('cmd') ?? name);
        } else {
          actionText = formatAction('tool', name);
        }
        if (actionText) {
          this.emit({ text: actionText, timestamp: Date.now(), type: 'system' });
        }
      }
      return;
    }

    // result event -> set status waiting
    if (eventType === 'result') {
      if (typeof event.result === 'string' && event.result.trim()) {
        this.emit({ text: event.result, timestamp: Date.now(), type: 'stdout' });
      }
      this.setStatus('waiting');
      return;
    }

    // error event
    if (eventType === 'error') {
      const errorMsg =
        (typeof event.message === 'string' ? event.message : '') ||
        (typeof event.error === 'string' ? event.error : '') ||
        'Unknown error';
      flog.error('AGENT', `[GEMINI] Error event: ${errorMsg}`);
      this.emit({ text: `Gemini error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
    }
  }

  protected handleStderrLine(line: string): void {
    flog.debug('AGENT', `[GEMINI stderr] ${line}`);
    // Auth consent error — Gemini CLI needs interactive authentication first
    if (line.includes('Interactive consent could not be obtained') || line.includes('Please run Gemini CLI in an interactive terminal')) {
      this.lastError = 'Gemini: authentification requise — lancez `gemini` seul pour vous connecter';
      this.emit({
        text: 'Gemini: authentification requise. Lancez `gemini` dans un terminal pour vous connecter.',
        timestamp: Date.now(),
        type: 'info',
      });
      return;
    }
    if (line.includes('Max attempts reached') || line.includes('Error when talking to Gemini API')) {
      this.consecutiveFailures++;
      const short = line.includes('No capacity')
        ? 'Gemini API: pas de capacite disponible (429)'
        : line.includes('Error when talking')
          ? 'Gemini API: erreur de connexion'
          : `Gemini: ${line.slice(0, 80)}`;
      this.lastError = short;
      this.emit({ text: short, timestamp: Date.now(), type: 'info' });
    } else if (line.includes('status 429') || line.includes('exhausted your capacity')) {
      this.consecutiveFailures++;
      flog.warn('AGENT', `[GEMINI] Rate limited (failure #${this.consecutiveFailures})`);
    }
  }

  /** Override send to add retry with exponential backoff on capacity errors */
  override send(prompt: string) {
    if (this.consecutiveFailures >= GeminiAgent.MAX_RETRIES) {
      const backoffMs = GeminiAgent.BASE_BACKOFF_MS * Math.pow(2, this.consecutiveFailures - 1);
      const cappedMs = Math.min(backoffMs, 30_000);
      flog.info('AGENT', `[GEMINI] Backoff ${cappedMs}ms before retry (failure #${this.consecutiveFailures})`);
      this.emit({
        text: `Gemini: attente ${Math.round(cappedMs / 1000)}s avant retry...`,
        timestamp: Date.now(),
        type: 'info',
      });
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null;
        super.send(prompt);
      }, cappedMs);
      return;
    }
    super.send(prompt);
  }

  override async stop(): Promise<void> {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    await super.stop();
  }

}
