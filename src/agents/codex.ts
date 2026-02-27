import type { SessionConfig } from './types.js';
import { BaseExecAgent } from './base-exec-agent.js';
import { flog } from '../utils/log.js';
import { formatAction } from '../utils/format-action.js';

export class CodexAgent extends BaseExecAgent {
  readonly id = 'codex' as const;

  protected get logTag() { return '[CODEX]'; }

  protected getCliPath(config: SessionConfig): string {
    return config.codexPath;
  }

  protected buildArgs(prompt: string): string[] {
    const args = ['exec'];

    if (this.sessionId) {
      args.push('resume', this.sessionId);
    }

    args.push(
      '--model',
      'gpt-5.3-codex',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-c',
      'model_reasoning_summary_effort="auto"',
      '--full-auto',
      '--json',
      '--skip-git-repo-check',
    );

    args.push(prompt);
    return args;
  }

  protected handleStreamEvent(event: Record<string, unknown>) {
    const eventType = typeof event.type === 'string' ? event.type : undefined;
    flog.debug('AGENT', `[CODEX event] ${eventType}`);

    // Extract thread/session ID
    if (eventType === 'thread.started' && typeof event.thread_id === 'string') {
      this.sessionId = event.thread_id;
      flog.info('AGENT', `[CODEX] Thread ID: ${this.sessionId}`);
    }

    // Detect context/thread errors
    if (eventType === 'error') {
      const errorMsg =
        (typeof event.message === 'string' ? event.message : '') ||
        (typeof event.error === 'string' ? event.error : '') ||
        'Unknown error';
      flog.error('AGENT', `[CODEX] Error event: ${errorMsg}`);
      this.emit({ text: `Codex error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
    }

    // Detect thread truncation / context limit
    if (eventType === 'thread.truncated' || eventType === 'context_limit_exceeded') {
      flog.warn('AGENT', `[CODEX] Context limit: ${eventType}`);
      this.emit({
        text: 'Codex: contexte tronque (limite atteinte)',
        timestamp: Date.now(),
        type: 'info',
      });
    }

    // item.completed — the main payload with text content
    if (eventType === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      const itemType = typeof item.type === 'string' ? item.type : undefined;
      const itemStatus = typeof item.status === 'string' ? item.status : undefined;

      // Reasoning summary — log only, don't display
      if (itemType === 'reasoning') {
        if (typeof item.text === 'string') flog.debug('AGENT', `[CODEX reasoning] ${item.text.slice(0, 120)}`);
        return;
      }

      // Agent message text (final response)
      if (itemType === 'agent_message' && typeof item.text === 'string') {
        this.emit({ text: item.text, timestamp: Date.now(), type: 'stdout' });
        return;
      }

      // OpenAI Responses API "message" type — final agent output
      if (itemType === 'message' || itemType === 'output_message') {
        const text = this.extractTextFromItem(item);
        if (text) {
          this.emit({ text, timestamp: Date.now(), type: 'stdout' });
          return;
        }
      }

      // File change events — show action + status
      if (itemType === 'file_change') {
        const filename = typeof item.filename === 'string' ? item.filename : undefined;
        const action = typeof item.action === 'string' ? item.action : undefined;
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
        const command = typeof item.command === 'string' ? item.command : undefined;
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        if (command) {
          const formatted = formatAction('bash', command);
          if (formatted) {
            const suffix = exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode})` : '';
            this.emit({ text: `${formatted}${suffix}`, timestamp: Date.now(), type: 'system' });
          }
          if (exitCode !== undefined && exitCode !== 0 && typeof item.stderr === 'string') {
            const short = item.stderr.length > 200 ? item.stderr.slice(0, 200) + '...' : item.stderr;
            this.emit({ text: short, timestamp: Date.now(), type: 'info' });
          }
          return;
        }
      }

      // File read events
      if (itemType === 'file_read' || itemType === 'read_file') {
        const filename = typeof item.filename === 'string' ? item.filename
          : typeof item.path === 'string' ? item.path : undefined;
        if (filename) {
          const formatted = formatAction('read', filename);
          if (formatted) this.emit({ text: formatted, timestamp: Date.now(), type: 'system' });
          return;
        }
      }

      // Generic: try to extract text from content array
      if (Array.isArray(item.content)) {
        for (const block of item.content as Array<Record<string, unknown>>) {
          if (typeof block.text === 'string') {
            this.emit({ text: block.text, timestamp: Date.now(), type: 'stdout' });
          }
        }
        return;
      }

      // Catch-all text extraction
      flog.info('AGENT', `[CODEX] Unhandled item.completed type="${itemType}" — attempting text extraction`);
      const fallbackText = this.extractTextFromItem(item);
      if (fallbackText) {
        this.emit({ text: fallbackText, timestamp: Date.now(), type: 'stdout' });
        return;
      }
      flog.warn('AGENT', `[CODEX] item.completed type="${itemType}" — no text extracted. Keys: ${Object.keys(item).join(', ')}`);
    }

    // item.started — skip
    if (eventType === 'item.started') return;

    // turn.completed — extract usage info, mark waiting
    if (eventType === 'turn.completed') {
      if (event.usage && typeof event.usage === 'object') {
        const usage = event.usage as Record<string, unknown>;
        const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
        const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
        if (input || output) {
          flog.info('AGENT', `[CODEX] Usage: ${input ?? '?'} in / ${output ?? '?'} out tokens`);
        }
      }
      this.setStatus('waiting');
    }
  }

  protected isNoiseLine(line: string): boolean {
    const trimmed = line.trim();
    if (/^>_\s*OpenAI\s+Codex/i.test(trimmed)) return true;
    if (/^directory:\s+/i.test(trimmed)) return true;
    if (/^model:\s+/i.test(trimmed)) return true;
    if (/^provider:\s+/i.test(trimmed)) return true;
    if (/^[─━┌┐└┘├┤┬┴┼│\-=+]+$/.test(trimmed)) return true;
    if (/^approval mode:/i.test(trimmed)) return true;
    return false;
  }

  /** Try to extract text from various item shapes */
  private extractTextFromItem(item: Record<string, unknown>): string | undefined {
    // Try content array
    if (Array.isArray(item.content)) {
      const texts: string[] = [];
      for (const block of item.content as Array<Record<string, unknown>>) {
        if (typeof block.text === 'string') texts.push(block.text);
      }
      if (texts.length > 0) return texts.join('\n');
    }
    // Try output array
    if (Array.isArray(item.output)) {
      const texts: string[] = [];
      for (const block of item.output as Array<Record<string, unknown>>) {
        if (typeof block.text === 'string') texts.push(block.text);
      }
      if (texts.length > 0) return texts.join('\n');
    }
    // Try direct text
    if (typeof item.text === 'string' && item.text.trim()) return item.text;
    // Try output string
    if (typeof item.output === 'string' && item.output.trim()) return item.output;
    return undefined;
  }
}
