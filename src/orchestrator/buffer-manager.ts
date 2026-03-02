import type { AgentId, OutputLine } from '../agents/types.js';
import type { OrchestratorCallbacks } from './orchestrator.js';
import { flog } from '../utils/log.js';

/**
 * Manages relay output buffers and throttled status snippets.
 * Buffers agent stdout while they work on delegated tasks, then flushes
 * to the UI when the relay completes.
 */
export class BufferManager {
  /** Buffered stdout while agent works on relay — flushed when relay ends */
  private readonly relayBuffer: Map<AgentId, OutputLine[]> = new Map([
    ['sonnet', []],
    ['codex', []],
    ['opus', []],
  ]);

  /** Last time a status snippet was emitted for each agent */
  private readonly lastSnippetTime: Map<AgentId, number> = new Map();

  /** Minimum interval (ms) between status snippets for the same agent */
  private readonly SNIPPET_INTERVAL_MS = 1200;

  // ── Buffer operations ──

  getBuffer(agent: AgentId): OutputLine[] {
    return this.relayBuffer.get(agent) ?? [];
  }

  pushToBuffer(agent: AgentId, line: OutputLine): void {
    this.relayBuffer.get(agent)!.push(line);
  }

  clearBuffer(agent: AgentId): void {
    this.relayBuffer.set(agent, []);
  }

  clearAllBuffers(): void {
    for (const key of this.relayBuffer.keys()) {
      this.relayBuffer.set(key, []);
    }
  }

  // ── Opus buffer flush ──

  /** Flush Opus buffered lines to UI, then clear the buffer */
  flushOpusBuffer(cb: OrchestratorCallbacks): void {
    const buffer = this.relayBuffer.get('opus') ?? [];
    if (buffer.length > 0) {
      flog.info('ORCH', `Flushing ${buffer.length} buffered Opus lines to UI`);
      for (const line of buffer) {
        cb.onAgentOutput('opus', line);
      }
    }
    this.relayBuffer.set('opus', []);
  }

  /** Extract Opus buffered stdout text (for combined delivery context) */
  getOpusBufferedText(): string {
    const buf = this.relayBuffer.get('opus') ?? [];
    return buf
      .filter(l => l.type === 'stdout')
      .map(l => l.text)
      .join('\n')
      .trim();
  }

  // ── Status snippets ──

  resetSnippetTime(agent: AgentId): void {
    this.lastSnippetTime.delete(agent);
  }

  /** Extract a short status snippet from agent stdout text for live UI display.
   *  Returns null if the text is not meaningful. */
  extractStatusSnippet(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 5) return null;
    // Skip relay/task/system tags
    if (/^\[(TO|FROM|TASK|RAPPEL|CODEX|SONNET|OPUS|FALLBACK):/i.test(trimmed)) return null;
    // Skip code blocks
    if (/^```/.test(trimmed)) return null;
    // Skip lines that are ONLY punctuation or formatting
    if (/^[─═\-*>|]+$/.test(trimmed)) return null;
    // Skip internal instructions
    if (/^(Tu es|You are|REGLE|RULE|IMPORTANT)/i.test(trimmed)) return null;
    // Skip tool action lines
    if (/^▸\s/.test(trimmed)) return null;

    const lines = trimmed.split('\n');
    let firstLine = '';
    for (const l of lines) {
      let lt = l.trim();
      if (!lt || /^[─═\-*>|`]+$/.test(lt)) continue;
      if (/^\[(TO|FROM|TASK|RAPPEL):/i.test(lt)) continue;
      if (/^▸\s/.test(lt)) continue;
      lt = lt.replace(/^#{1,6}\s+/, '');
      if (lt.length < 3) continue;
      firstLine = lt;
      break;
    }
    if (!firstLine || firstLine.length < 5) return null;
    if (firstLine.replace(/[^a-zA-Zà-ÿ0-9]/g, '').length < 4) return null;
    return firstLine;
  }

  /** Emit a throttled status snippet for an agent on relay */
  maybeEmitStatusSnippet(agentId: AgentId, text: string, cb: OrchestratorCallbacks): void {
    const now = Date.now();
    const lastTime = this.lastSnippetTime.get(agentId) ?? 0;
    if (now - lastTime < this.SNIPPET_INTERVAL_MS) return;

    const snippet = this.extractStatusSnippet(text);
    if (!snippet) return;

    this.lastSnippetTime.set(agentId, now);
    cb.onAgentOutput(agentId, {
      text: `✦ ${snippet}`,
      timestamp: now,
      type: 'system',
    });
  }

  // ── Reset ──

  reset(): void {
    this.relayBuffer.set('sonnet', []);
    this.relayBuffer.set('codex', []);
    this.relayBuffer.set('opus', []);
    this.lastSnippetTime.clear();
  }
}
