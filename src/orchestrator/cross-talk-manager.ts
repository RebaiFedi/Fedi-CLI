import type { AgentId } from '../agents/types.js';
import { loadUserConfig } from '../config/user-config.js';

/** A cross-talk message waiting to be delivered when the current turn ends */
export interface PendingCrossTalkMessage {
  from: AgentId;
  target: AgentId;
  content: string;
}

/**
 * Manages cross-talk state between worker agents (Sonnet <-> Codex).
 * Tracks message count, mute timers, pending reply expectations,
 * and turn-based speaking order to prevent simultaneous cross-talk deadlocks.
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

  /** Turn-based speaking: which agent currently holds the cross-talk turn */
  private currentSpeaker: AgentId | null = null;

  /** When two agents try to speak simultaneously, the second message is queued */
  private pendingQueue: PendingCrossTalkMessage | null = null;

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

  // ── Turn-based speaking ──

  /** Returns true if this agent can speak (no one speaking, or it's their turn) */
  canSpeak(agent: AgentId): boolean {
    return this.currentSpeaker === null || this.currentSpeaker === agent;
  }

  /** Claim the cross-talk turn for this agent */
  claimTurn(agent: AgentId): void {
    this.currentSpeaker = agent;
  }

  /** Release the cross-talk turn so another agent can speak */
  releaseTurn(): void {
    this.currentSpeaker = null;
  }

  /** Get the agent that currently holds the speaking turn */
  getCurrentSpeaker(): AgentId | null {
    return this.currentSpeaker;
  }

  /** Queue a message from a second agent that tried to speak simultaneously */
  queueMessage(from: AgentId, target: AgentId, content: string): void {
    this.pendingQueue = { from, target, content };
  }

  /** Retrieve and remove the pending queued message (if any) */
  dequeuePending(): PendingCrossTalkMessage | null {
    const msg = this.pendingQueue;
    this.pendingQueue = null;
    return msg;
  }

  /** Check whether there is a pending queued message */
  hasPendingMessage(): boolean {
    return this.pendingQueue !== null;
  }

  // ── Bulk operations ──

  reset(): void {
    this.count = 0;
    this.onCrossTalk.clear();
    this.awaitingReply.clear();
    this.currentSpeaker = null;
    this.pendingQueue = null;
  }

  /** Clear both cross-talk maps for a specific agent */
  clearAgent(agent: AgentId): void {
    this.onCrossTalk.delete(agent);
    this.awaitingReply.delete(agent);
    if (this.currentSpeaker === agent) {
      this.currentSpeaker = null;
    }
    if (this.pendingQueue?.from === agent) {
      this.pendingQueue = null;
    }
  }
}
