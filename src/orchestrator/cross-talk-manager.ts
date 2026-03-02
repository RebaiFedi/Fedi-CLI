import type { AgentId } from '../agents/types.js';
import { loadUserConfig } from '../config/user-config.js';

/**
 * Manages cross-talk state between worker agents (Sonnet ↔ Codex).
 * Tracks message count, mute timers, and pending reply expectations.
 */
export class CrossTalkManager {
  private count = 0;
  private get maxPerRound(): number {
    return loadUserConfig().maxCrossTalkPerRound;
  }

  /** Agents responding to a cross-talk message — stdout muted until timeout */
  private readonly onCrossTalk: Map<AgentId, number> = new Map();

  /** Agents that initiated cross-talk and are waiting for a peer reply.
   *  While waiting, safety-net auto-relay must NOT trigger. */
  private readonly awaitingReply: Set<AgentId> = new Set();

  // ── Count ──

  get crossTalkCount(): number {
    return this.count;
  }

  isAtLimit(): boolean {
    return this.count >= this.maxPerRound;
  }

  increment(): void {
    this.count++;
  }

  resetCount(): void {
    this.count = 0;
  }

  // ── On-cross-talk mute ──

  isOnCrossTalk(agent: AgentId): boolean {
    return this.onCrossTalk.has(agent);
  }

  getCrossTalkTime(agent: AgentId): number | undefined {
    return this.onCrossTalk.get(agent);
  }

  setOnCrossTalk(agent: AgentId, timestamp = Date.now()): void {
    this.onCrossTalk.set(agent, timestamp);
  }

  clearOnCrossTalk(agent: AgentId): void {
    this.onCrossTalk.delete(agent);
  }

  // ── Awaiting reply ──

  isAwaitingReply(agent: AgentId): boolean {
    return this.awaitingReply.has(agent);
  }

  setAwaitingReply(agent: AgentId): void {
    this.awaitingReply.add(agent);
  }

  clearAwaitingReply(agent: AgentId): void {
    this.awaitingReply.delete(agent);
  }

  // ── Bulk operations ──

  reset(): void {
    this.count = 0;
    this.onCrossTalk.clear();
    this.awaitingReply.clear();
  }

  /** Clear both cross-talk maps for a specific agent */
  clearAgent(agent: AgentId): void {
    this.onCrossTalk.delete(agent);
    this.awaitingReply.delete(agent);
  }
}
