import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Message, AgentId } from '../agents/types.js';
import { MAX_RELAY_DEPTH } from '../agents/types.js';
import { logger } from '../utils/logger.js';

export interface MessageBusEvents {
  message: [Message];
  'message:claude': [Message];
  'message:codex': [Message];
  'message:haiku': [Message];
  relay: [Message];
  'relay-blocked': [Message];
}

export class MessageBus extends EventEmitter {
  private history: Message[] = [];

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  send(msg: Omit<Message, 'id' | 'timestamp' | 'relayCount'> & { relayCount?: number }): Message {
    const full: Message = {
      ...msg,
      id: randomUUID(),
      timestamp: Date.now(),
      relayCount: msg.relayCount ?? 0,
    };

    this.history.push(full);
    logger.info(`[BUS] ${full.from} → ${full.to}: ${full.content.slice(0, 100)}`);

    this.emit('message', full);

    if (full.to === 'claude') {
      this.emit('message:claude', full);
    } else if (full.to === 'codex') {
      this.emit('message:codex', full);
    } else if (full.to === 'haiku') {
      this.emit('message:haiku', full);
    } else if (full.to === 'all') {
      this.emit('message:claude', full);
      this.emit('message:codex', full);
      this.emit('message:haiku', full);
    }

    return full;
  }

  relay(from: AgentId, to: AgentId, content: string, correlationId?: string): boolean {
    const relayCount = correlationId
      ? this.history.filter(m => m.correlationId === correlationId).length
      : 0;

    if (relayCount >= MAX_RELAY_DEPTH) {
      const blocked: Message = {
        id: randomUUID(),
        from,
        to,
        content,
        correlationId,
        relayCount,
        timestamp: Date.now(),
      };
      logger.warn(`[BUS] Relay blocked (depth ${relayCount}): ${content.slice(0, 80)}`);
      this.emit('relay-blocked', blocked);
      return false;
    }

    const corrId = correlationId ?? randomUUID();
    const msg = this.send({
      from,
      to,
      content,
      correlationId: corrId,
      relayCount: relayCount + 1,
    });

    this.emit('relay', msg);
    return true;
  }

  getHistory(): readonly Message[] {
    return this.history;
  }

  getRelayHistory(): readonly Message[] {
    return this.history.filter(m => m.correlationId != null);
  }

  /**
   * Get a compact summary of recent messages that `forAgent` hasn't seen yet.
   * Used to inject cross-agent context when relaying messages.
   */
  getContextSummary(forAgent: AgentId, sinceIndex: number, maxMessages = 5): { summary: string; newIndex: number } {
    const relevant = this.history
      .slice(sinceIndex)
      .filter(m => m.to !== forAgent && m.from !== forAgent);

    if (relevant.length === 0) return { summary: '', newIndex: this.history.length };

    const recent = relevant.slice(-maxMessages);
    const lines = recent.map(m => {
      const content = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
      return `[${m.from.toUpperCase()}→${m.to.toUpperCase()}] ${content}`;
    });

    return {
      summary: lines.join('\n'),
      newIndex: this.history.length,
    };
  }
}
