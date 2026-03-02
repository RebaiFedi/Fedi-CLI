import { randomUUID } from 'node:crypto';
import type { AgentId, AgentProcess, Message } from '../agents/types.js';
import { TO_SONNET_PATTERN, TO_CODEX_PATTERN, TO_OPUS_PATTERN } from '../agents/types.js';
import type { MessageBus } from './message-bus.js';
import type { OrchestratorCallbacks } from './orchestrator.js';
import type { DelegateTracker } from './delegate-tracker.js';
import type { CrossTalkManager } from './cross-talk-manager.js';
import type { BufferManager } from './buffer-manager.js';
import { flog } from '../utils/log.js';
import { loadUserConfig } from '../config/user-config.js';

const _cfg = loadUserConfig();
const RELAY_WINDOW_MS = _cfg.relayWindowMs;
const MAX_RELAYS_PER_WINDOW = _cfg.maxRelaysPerWindow;

/** Dependencies injected into RelayRouter */
export interface RelayRouterDeps {
  agents: Record<AgentId, AgentProcess>;
  bus: MessageBus;
  delegates: DelegateTracker;
  crossTalk: CrossTalkManager;
  buffers: BufferManager;
  getCallbacks: () => OrchestratorCallbacks | null;
  isAgentEnabled: (id: AgentId) => boolean;
  /** Called when Opus delegates in @tous mode (cancels worker timer) */
  onOpusDelegated?: () => void;
}

/**
 * Detects [TO:*] relay tags in streamed output, manages relay drafts,
 * and routes messages between agents with guard rails (rate limiting,
 * cross-talk limits, duplicate delegation blocking).
 */
export class RelayRouter {
  /** Agents currently working on a relay from Opus */
  readonly agentsOnRelay: Set<AgentId> = new Set();
  /** Timestamp when relay started for each agent */
  readonly relayStartTime: Map<AgentId, number> = new Map();

  /** When true, next opus→agent relay is a LIVE message forwarding */
  liveRelayAllowed = false;

  /** Rate limiting */
  private relayTimestamps: number[] = [];

  /** Stateful relay drafts to avoid truncating [TO:*] across chunks */
  private readonly relayDrafts: Map<AgentId, { target: AgentId; parts: string[] }> = new Map();
  private readonly relayDraftTimers: Map<AgentId, ReturnType<typeof setTimeout>> = new Map();
  private readonly relayDraftEmptyRetries: Map<AgentId, number> = new Map();
  private readonly RELAY_DRAFT_FLUSH_MS = 150;
  private readonly RELAY_DRAFT_MAX_EMPTY_RETRIES = 12;

  /** Per-agent relay timeouts */
  private readonly RELAY_TIMEOUT_MS = _cfg.execTimeoutMs;
  private readonly CODEX_RELAY_TIMEOUT_MS = _cfg.codexTimeoutMs;

  /** Direct mode agents — relays from Opus blocked */
  readonly directModeAgents: Set<AgentId> = new Set();

  private readonly deps: RelayRouterDeps;

  constructor(deps: RelayRouterDeps) {
    this.deps = deps;
  }

  // ── Tag detection helpers ──

  isRelayTag(line: string): boolean {
    return TO_SONNET_PATTERN.test(line) || TO_CODEX_PATTERN.test(line) || TO_OPUS_PATTERN.test(line);
  }

  private matchRelayTag(line: string, from: Message['from']): { target: AgentId; firstLine: string } | null {
    if (from !== 'sonnet' && from !== 'codex' && from !== 'opus') return null;
    if (from !== 'sonnet') {
      const m = line.match(TO_SONNET_PATTERN);
      if (m) return { target: 'sonnet', firstLine: m[1].trim() };
    }
    if (from !== 'codex') {
      const m = line.match(TO_CODEX_PATTERN);
      if (m) return { target: 'codex', firstLine: m[1].trim() };
    }
    if (from !== 'opus') {
      const m = line.match(TO_OPUS_PATTERN);
      if (m) return { target: 'opus', firstLine: m[1].trim() };
    }
    return null;
  }

  private isMarkdownContext(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) return true;
    if (trimmed.startsWith('> ')) return true;
    if (trimmed.startsWith('    ')) return true;
    if (/`[^`]*\[TO:(?:SONNET|CODEX|OPUS)\][^`]*`/.test(line)) return true;
    if (/^\s*[-*]\s.*\[TO:(?:SONNET|CODEX|OPUS)\].*:/.test(line)) return true;
    if (/[*_]{1,2}\[TO:(?:SONNET|CODEX|OPUS)\][*_]{1,2}/.test(line)) return true;
    return false;
  }

  // ── Rate limiting ──

  isRateLimited(now = Date.now()): boolean {
    while (this.relayTimestamps.length > 0 && now - this.relayTimestamps[0] >= RELAY_WINDOW_MS) {
      this.relayTimestamps.shift();
    }
    return this.relayTimestamps.length >= MAX_RELAYS_PER_WINDOW;
  }

  recordRelay(): void {
    this.relayTimestamps.push(Date.now());
  }

  // ── Relay waiting check ──

  isOpusWaitingForRelays(): boolean {
    for (const agent of this.agentsOnRelay) {
      if (agent !== 'opus') return true;
    }
    return false;
  }

  /** Get the relay timeout for a specific agent */
  getRelayTimeout(agentId: AgentId): number {
    return agentId === 'codex' ? this.CODEX_RELAY_TIMEOUT_MS : this.RELAY_TIMEOUT_MS;
  }

  // ── Relay draft management ──

  getDraft(from: AgentId): { target: AgentId; parts: string[] } | undefined {
    return this.relayDrafts.get(from);
  }

  flushRelayDraft(from: AgentId, force = true): boolean {
    const timer = this.relayDraftTimers.get(from);
    if (timer) {
      clearTimeout(timer);
      this.relayDraftTimers.delete(from);
    }

    const draft = this.relayDrafts.get(from);
    if (!draft) return false;

    const content = draft.parts.join('\n').trim();

    if (!content) {
      const retries = this.relayDraftEmptyRetries.get(from) ?? 0;
      if (retries < this.RELAY_DRAFT_MAX_EMPTY_RETRIES) {
        this.relayDraftEmptyRetries.set(from, retries + 1);
        flog.debug('RELAY', `Draft for ${from}->${draft.target} still empty (force=${force}), retry ${retries + 1}/${this.RELAY_DRAFT_MAX_EMPTY_RETRIES}`);
        this.scheduleRelayDraftFlush(from);
        return false;
      }
      flog.debug('RELAY', `Draft for ${from}->${draft.target} empty after max retries, dropping`);
      this.relayDrafts.delete(from);
      this.relayDraftEmptyRetries.delete(from);
      return false;
    }

    this.relayDrafts.delete(from);
    this.relayDraftEmptyRetries.delete(from);
    this.routeRelayMessage(from, draft.target, content);
    return true;
  }

  private scheduleRelayDraftFlush(from: AgentId): void {
    const prev = this.relayDraftTimers.get(from);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.relayDraftTimers.delete(from);
      this.flushRelayDraft(from, false);
    }, this.RELAY_DRAFT_FLUSH_MS);
    this.relayDraftTimers.set(from, timer);
  }

  // ── Pattern detection (streamed output) ──

  detectRelayPatterns(from: AgentId, text: string): boolean {
    const rawLines = text.split('\n');
    const lines: string[] = [];
    const multiTagRe = /(\[TO:(?:SONNET|CODEX|OPUS)\])/g;
    for (const raw of rawLines) {
      if (this.isMarkdownContext(raw)) {
        flog.debug('RELAY', `Skipping markdown context line: ${raw.slice(0, 80)}`);
        const draft = this.relayDrafts.get(from);
        if (draft && raw.trim()) {
          draft.parts.push(raw);
          this.scheduleRelayDraftFlush(from);
        }
        continue;
      }
      const tags: { idx: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = multiTagRe.exec(raw)) !== null) {
        tags.push({ idx: m.index });
      }
      if (tags.length <= 1) {
        lines.push(raw);
      } else {
        for (let t = 0; t < tags.length; t++) {
          const start = tags[t].idx;
          const end = t + 1 < tags.length ? tags[t + 1].idx : raw.length;
          lines.push(raw.slice(start, end).trimEnd());
        }
      }
    }

    let foundRelayTag = false;
    for (const line of lines) {
      const match = this.matchRelayTag(line, from);
      if (match) {
        foundRelayTag = true;
        const prevDraft = this.relayDrafts.get(from);
        if (prevDraft) {
          const prevContent = prevDraft.parts.join('\n').trim();
          if (prevContent) {
            this.relayDrafts.delete(from);
            this.relayDraftEmptyRetries.delete(from);
            this.routeRelayMessage(from, prevDraft.target, prevContent);
          } else {
            const prevTimer = this.relayDraftTimers.get(from);
            if (prevTimer) {
              clearTimeout(prevTimer);
              this.relayDraftTimers.delete(from);
            }
            this.relayDrafts.delete(from);
            this.relayDraftEmptyRetries.delete(from);
            flog.debug('RELAY', `Discarded empty draft ${from}->${prevDraft.target} (superseded by new tag ->${match.target})`);
          }
        }
        const draft = { target: match.target, parts: [] as string[] };
        if (match.firstLine) draft.parts.push(match.firstLine);
        this.relayDrafts.set(from, draft);
        this.relayDraftEmptyRetries.delete(from);
        this.scheduleRelayDraftFlush(from);
        continue;
      }

      const draft = this.relayDrafts.get(from);
      if (draft) {
        const isNoise =
          !line.trim() ||
          /^\s*---+\s*$/.test(line) ||
          /^\s*\[TASK:(add|done)\]/i.test(line);
        if (!isNoise) draft.parts.push(line);
        this.scheduleRelayDraftFlush(from);
      }
    }

    return foundRelayTag;
  }

  // ── Core routing with guard rails ──

  routeRelayMessage(from: AgentId, target: AgentId, rawContent: string): void {
    const content = rawContent.trim();
    if (!content) return;
    if (content.replace(/[`'".,;:\-–—\s]/g, '').length < 3) {
      flog.debug('RELAY', `Dropping fragment relay ${from}->${target}: "${content}"`);
      return;
    }

    const cb = this.deps.getCallbacks();

    if (!this.deps.isAgentEnabled(target)) {
      if (from === 'opus') {
        cb?.onAgentOutput('opus', {
          text: `Delegation ignoree: ${target} est desactive`,
          timestamp: Date.now(),
          type: 'info',
        });
      }
      flog.info('RELAY', `BLOCKED ${from}->${target} (agent disabled)`);
      return;
    }

    if (from === 'opus' && this.directModeAgents.has(target)) {
      flog.info('RELAY', `BLOCKED ${from}->${target} (user speaking directly to ${target})`);
      return;
    }

    flog.info('RELAY', `${from}->${target}: ${content.slice(0, 80)}`);

    // ── Cross-talk: peer-to-peer ──
    const isPeerToPeer = from !== 'opus' && target !== 'opus' && from !== target;

    if (isPeerToPeer) {
      const bothReported = this.deps.delegates.expectedDelegates.size > 0 &&
        this.deps.delegates.pendingReports.size >= this.deps.delegates.expectedDelegates.size;
      if (bothReported) {
        flog.info('ORCH', `Cross-talk BLOCKED ${from}->${target} (all delegates already reported)`);
        this.deps.crossTalk.clearOnCrossTalk(from);
        this.deps.crossTalk.clearOnCrossTalk(target);
        this.deps.delegates.deliverCombinedReports();
        return;
      }
      if (this.deps.delegates.pendingReports.has(from)) {
        flog.info('ORCH', `Cross-talk BLOCKED ${from}->${target} (${from} already reported to Opus)`);
        return;
      }
      if (this.deps.crossTalk.isAtLimit()) {
        flog.warn('ORCH', `Cross-talk limit reached — blocking ${from}->${target}`);
      } else {
        this.deps.crossTalk.increment();
        flog.info('ORCH', `Cross-talk ${this.deps.crossTalk.crossTalkCount}: ${from}->${target}`);
        this.deps.crossTalk.setAwaitingReply(from);
        this.deps.crossTalk.setOnCrossTalk(target);
        flog.info('ORCH', `Cross-talk MUTE SET for ${target}, ${from} awaiting reply`);
        this.deps.bus.relay(from, target, content);
      }
      return;
    }

    // ── Rate limit (standard relays only) ──
    if (this.isRateLimited()) {
      flog.warn('ORCH', `Relay rate limited — skipping from ${from}`);
      cb?.onAgentOutput(from, {
        text: '[Rate limit] Trop de relays — patientez quelques secondes.',
        timestamp: Date.now(),
        type: 'info',
      });
      return;
    }

    // ── Standard delegation / report flow ──
    if (from === 'opus' && target !== 'opus') {
      if (this.agentsOnRelay.has(target) && this.deps.delegates.expectedDelegates.has(target)) {
        if (this.liveRelayAllowed) {
          this.liveRelayAllowed = false;
          flog.info('RELAY', `LIVE relay opus->${target}: ${content.slice(0, 80)}`);
          const targetAgent = this.deps.agents[target];
          if (targetAgent.status === 'running') {
            targetAgent.sendUrgent(`[LIVE MESSAGE DU USER — via Opus] ${content}`);
          } else {
            this.deps.bus.send({ from: 'opus', to: target, content: `[LIVE MESSAGE DU USER — via Opus] ${content}` });
          }
          this.recordRelay();
          this.deps.bus.emit('relay', {
            id: randomUUID(),
            from: 'opus' as const,
            to: target,
            content,
            relayCount: 0,
            timestamp: Date.now(),
          });
          return;
        }
        flog.info('RELAY', `BLOCKED duplicate delegation opus->${target}`);
        return;
      }

      // Opus delegated — notify for @tous timer cancellation
      this.deps.onOpusDelegated?.();

      this.deps.delegates.deliveredToOpus.delete(target);
      this.agentsOnRelay.add(target);
      this.relayStartTime.set(target, Date.now());
      this.deps.buffers.resetSnippetTime(target);
      this.deps.delegates.expectedDelegates.add(target);
      this.deps.delegates.lastDelegationContent.set(target, content);
      flog.info('ORCH', `Expected delegates: ${[...this.deps.delegates.expectedDelegates].join(', ')}`);
      this.deps.delegates.resetDelegateTimeout();
    }

    this.recordRelay();

    // Agent reporting back to Opus — buffer for combined delivery
    if (target === 'opus' && from !== 'opus' && this.deps.delegates.expectedDelegates.has(from)) {
      this.deps.delegates.pendingReports.set(from, content);
      this.agentsOnRelay.delete(from);
      this.deps.buffers.clearBuffer(from);
      this.relayStartTime.delete(from);
      this.deps.crossTalk.clearAwaitingReply(from);
      this.deps.delegates.clearSafetyNetTimer(from);

      if (this.deps.crossTalk.isOnCrossTalk(from)) {
        flog.info('ORCH', `Clearing cross-talk mute for ${from} (reported to Opus)`);
        this.deps.crossTalk.clearOnCrossTalk(from);
      }

      flog.info('ORCH', `Buffered report from ${from} (${this.deps.delegates.pendingReports.size}/${this.deps.delegates.expectedDelegates.size} received)`);

      const reportPreview = this.deps.buffers.extractStatusSnippet(content);
      if (reportPreview && cb) {
        cb.onAgentOutput(from, {
          text: `✦ ${reportPreview}`,
          timestamp: Date.now(),
          type: 'system',
        });
      }

      if (this.deps.delegates.pendingReports.size >= this.deps.delegates.expectedDelegates.size) {
        this.deps.delegates.deliverCombinedReports();
      }
      return;
    }

    this.deps.bus.relay(from, target, content);
    if (target === 'opus' && from !== 'opus') {
      this.deps.buffers.clearBuffer(from);
    }
  }

  // ── Reset ──

  reset(): void {
    this.agentsOnRelay.clear();
    this.relayStartTime.clear();
    this.relayTimestamps = [];
    this.relayDrafts.clear();
    for (const timer of this.relayDraftTimers.values()) clearTimeout(timer);
    this.relayDraftTimers.clear();
    this.relayDraftEmptyRetries.clear();
    this.liveRelayAllowed = false;
  }

  /** Clear all timers (for shutdown) */
  clearAllTimers(): void {
    this.relayDrafts.clear();
    for (const timer of this.relayDraftTimers.values()) clearTimeout(timer);
    this.relayDraftTimers.clear();
  }
}
