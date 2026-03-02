import { randomUUID } from 'node:crypto';
import type { AgentId, AgentProcess, OutputLine } from '../agents/types.js';
import type { MessageBus } from './message-bus.js';
import type { OrchestratorCallbacks } from './orchestrator.js';
import type { CrossTalkManager } from './cross-talk-manager.js';
import type { BufferManager } from './buffer-manager.js';
import { flog } from '../utils/log.js';
import { loadUserConfig } from '../config/user-config.js';

const _cfg = loadUserConfig();

/** Circuit breaker state per agent */
interface CircuitState {
  failures: number;
  openedAt: number | null;
}

/** Dependencies injected into DelegateTracker */
export interface DelegateTrackerDeps {
  agents: Record<AgentId, AgentProcess>;
  bus: MessageBus;
  crossTalk: CrossTalkManager;
  buffers: BufferManager;
  getCallbacks: () => OrchestratorCallbacks | null;
  isAgentEnabled: (id: AgentId) => boolean;
}

/**
 * Tracks Opus→agent delegations, collects reports from delegates,
 * delivers combined reports, handles fallback and heartbeat monitoring.
 */
export class DelegateTracker {
  /** Agents that Opus delegated to — we wait for ALL before delivering */
  readonly expectedDelegates: Set<AgentId> = new Set();
  /** Buffered reports from delegates — delivered as one combined message */
  readonly pendingReports: Map<AgentId, string> = new Map();
  /** Agents whose combined report has been delivered — mute ALL late output */
  readonly deliveredToOpus: Set<AgentId> = new Set();
  /** Last delegation content — used for auto-fallback */
  readonly lastDelegationContent: Map<AgentId, string> = new Map();

  /** Safety-net timers for auto-relay */
  private readonly safetyNetTimers: Map<AgentId, ReturnType<typeof setTimeout>> = new Map();

  /** Heartbeat interval for monitoring delegates */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lastActivity: Map<AgentId, number> = new Map();
  private readonly IDLE_TIMEOUT_MS = _cfg.delegateTimeoutMs;
  private readonly HEARTBEAT_INTERVAL_MS = 10_000;
  private readonly CODEX_TIMEOUT_MS = _cfg.codexTimeoutMs;

  /** Circuit breaker — track consecutive failures per agent */
  private readonly circuitBreaker: Map<AgentId, CircuitState> = new Map();
  private readonly CB_THRESHOLD = _cfg.circuitBreakerThreshold;
  private readonly CB_COOLDOWN_MS = _cfg.circuitBreakerCooldownMs;

  private readonly deps: DelegateTrackerDeps;

  constructor(deps: DelegateTrackerDeps) {
    this.deps = deps;
  }

  // ── Public getters ──

  get hasPendingDelegates(): boolean {
    return this.expectedDelegates.size > 0;
  }

  // ── Activity tracking ──

  recordActivity(agent: AgentId): void {
    if (this.expectedDelegates.has(agent)) {
      this.lastActivity.set(agent, Date.now());
    }
  }

  // ── Safety-net timers ──

  setSafetyNetTimer(agentId: AgentId, timer: ReturnType<typeof setTimeout>): void {
    this.clearSafetyNetTimer(agentId);
    this.safetyNetTimers.set(agentId, timer);
  }

  clearSafetyNetTimer(agentId: AgentId): void {
    const timer = this.safetyNetTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.safetyNetTimers.delete(agentId);
    }
  }

  // ── Heartbeat ──

  /** Start/reset the heartbeat that monitors delegates */
  resetDelegateTimeout(): void {
    const now = Date.now();
    for (const delegate of this.expectedDelegates) {
      if (!this.lastActivity.has(delegate)) {
        this.lastActivity.set(delegate, now);
      }
    }
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.expectedDelegates.size === 0) {
        this.stopHeartbeat();
        return;
      }

      const now = Date.now();
      const timedOut: AgentId[] = [];

      for (const delegate of this.expectedDelegates) {
        if (this.pendingReports.has(delegate)) continue;
        const agent = this.deps.agents[delegate];
        const lastAct = this.lastActivity.get(delegate) ?? now;
        const idleMs = now - lastAct;

        if (agent.status === 'running') {
          this.lastActivity.set(delegate, now);
          flog.debug('ORCH', `Heartbeat: ${delegate} still running (active)`);
          continue;
        }

        const idleTimeout =
          delegate === 'codex' && this.CODEX_TIMEOUT_MS >= 0
            ? this.CODEX_TIMEOUT_MS
            : this.IDLE_TIMEOUT_MS;
        if (idleTimeout > 0 && idleMs >= idleTimeout) {
          flog.warn(
            'ORCH',
            `Heartbeat: ${delegate} idle for ${Math.round(idleMs / 1000)}s (status=${agent.status}) — timing out`,
          );
          timedOut.push(delegate);
        } else {
          flog.debug(
            'ORCH',
            `Heartbeat: ${delegate} idle ${Math.round(idleMs / 1000)}s/${idleTimeout > 0 ? Math.round(idleTimeout / 1000) + 's' : '∞'} (status=${agent.status})`,
          );
        }
      }

      if (timedOut.length === 0) return;

      for (const delegate of timedOut) {
        const fallback = this.pickFallbackAgent(delegate);
        const originalTask = this.lastDelegationContent.get(delegate);
        const cb = this.deps.getCallbacks();

        if (fallback === 'opus' && originalTask) {
          flog.info('ORCH', `Heartbeat timeout: both workers unavailable — Opus takes over`);
          this.expectedDelegates.clear();
          this.pendingReports.clear();
          this.stopHeartbeat();
          this.deps.bus.send({
            from: 'system',
            to: 'opus',
            content: `[FALLBACK — ${delegate} timeout, aucun agent disponible] Fais le travail toi-meme: ${originalTask}`,
          });
          cb?.onAgentOutput(delegate, {
            text: `${delegate} timeout — Opus prend le relais`,
            timestamp: Date.now(),
            type: 'info',
          });
          return;
        }

        if (fallback && fallback !== 'opus' && originalTask) {
          flog.info('ORCH', `Heartbeat fallback: ${delegate} → ${fallback}`);
          this.expectedDelegates.add(fallback);
          this.deliveredToOpus.delete(fallback);
          this.lastDelegationContent.set(fallback, originalTask);
          this.lastActivity.set(fallback, Date.now());
          this.deps.bus.relay('opus', fallback, `[FALLBACK — ${delegate} timeout] ${originalTask}`);
          cb?.onAgentOutput(delegate, {
            text: `${delegate} timeout — tache redirigee vers ${fallback}`,
            timestamp: Date.now(),
            type: 'info',
          });
          return;
        }

        flog.warn('ORCH', `${delegate} timeout — no fallback available, using placeholder`);
        this.pendingReports.set(delegate, '(timeout — pas de rapport)');
        cb?.onAgentOutput(delegate, {
          text: `${delegate} timeout — pas de reponse (aucun agent de secours disponible)`,
          timestamp: Date.now(),
          type: 'info',
        });
      }

      if (this.pendingReports.size >= this.expectedDelegates.size) {
        this.stopHeartbeat();
        this.deliverCombinedReports();
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.lastActivity.clear();
  }

  // ── Circuit breaker ──

  /** Record a successful completion — resets failure count */
  recordSuccess(agent: AgentId): void {
    this.circuitBreaker.delete(agent);
  }

  /** Record a failure — increments count, opens breaker if threshold reached */
  recordFailure(agent: AgentId): void {
    const state = this.circuitBreaker.get(agent) ?? { failures: 0, openedAt: null };
    state.failures++;
    if (state.failures >= this.CB_THRESHOLD) {
      state.openedAt = Date.now();
      flog.warn(
        'ORCH',
        `Circuit breaker OPEN for ${agent} (${state.failures} consecutive failures)`,
      );
    }
    this.circuitBreaker.set(agent, state);
  }

  /** Check if circuit is open (agent should not receive fallback work) */
  isCircuitOpen(agent: AgentId): boolean {
    const state = this.circuitBreaker.get(agent);
    if (!state?.openedAt) return false;
    if (Date.now() - state.openedAt >= this.CB_COOLDOWN_MS) {
      flog.info(
        'ORCH',
        `Circuit breaker HALF-OPEN for ${agent} (cooldown elapsed) — allowing retry`,
      );
      state.openedAt = null;
      state.failures = 0;
      return false;
    }
    return true;
  }

  // ── Fallback ──

  pickFallbackAgent(failedAgent: AgentId): AgentId | null {
    this.recordFailure(failedAgent);
    const fallbackMap: Record<string, AgentId[]> = {
      sonnet: ['codex'],
      codex: ['sonnet'],
    };
    this.expectedDelegates.delete(failedAgent);
    const candidates = fallbackMap[failedAgent] ?? [];
    for (const candidate of candidates) {
      if (!this.deps.isAgentEnabled(candidate)) continue;
      if (this.expectedDelegates.has(candidate)) continue;
      if (this.isCircuitOpen(candidate)) {
        flog.info('ORCH', `Fallback candidate ${candidate} skipped (circuit breaker open)`);
        continue;
      }
      const agent = this.deps.agents[candidate];
      if (agent.status === 'error' || agent.status === 'stopped') {
        flog.info('ORCH', `Fallback candidate ${candidate} skipped (status=${agent.status})`);
        continue;
      }
      return candidate;
    }
    flog.info('ORCH', `No worker fallback for ${failedAgent} — Opus will handle directly`);
    return 'opus';
  }

  // ── Cross-talk pending check ──

  hasCrossTalkPending(): boolean {
    for (const delegate of this.expectedDelegates) {
      if (this.deps.crossTalk.isOnCrossTalk(delegate)) {
        flog.debug(
          'ORCH',
          `Cross-talk still active for delegate ${delegate} — holding combined delivery`,
        );
        return true;
      }
    }
    return false;
  }

  // ── Combined report delivery ──

  deliverCombinedReports(): void {
    if (this.pendingReports.size === 0) return;
    if (this.hasCrossTalkPending()) {
      flog.info('ORCH', `Combined delivery deferred — cross-talk still active`);
      return;
    }

    const agentNames = [...this.pendingReports.keys()].map(
      (a) => a.charAt(0).toUpperCase() + a.slice(1),
    );
    const parts: string[] = [];
    const REPORT_MAX_CHARS = 5000;
    for (const [agent, report] of this.pendingReports) {
      const trimmed =
        report.length > REPORT_MAX_CHARS
          ? report.slice(0, REPORT_MAX_CHARS) +
            '\n... [rapport tronqué — contenu complet dans les fichiers]'
          : report;
      parts.push(`[FROM:${agent.toUpperCase()}] ${trimmed}`);
    }
    const reportsBody = parts.join('\n\n---\n\n');

    const opusAnalysis = this.deps.buffers.getOpusBufferedText();
    const opusSection = opusAnalysis
      ? `\n\n---\n\n[TA PROPRE ANALYSE (non montrée au user)] Voici ce que tu as écrit pendant que tes agents travaillaient. UTILISE cette analyse pour enrichir ta synthese finale:\n${opusAnalysis}`
      : '';

    const combined = `[RAPPORTS RECUS — ${agentNames.join(' + ')}] Tous les rapports sont arrivés.

INSTRUCTIONS CRITIQUES:
1. Ecris un rapport final complet et structure pour le user — fusionne les rapports de tes agents
2. Le user n'a RIEN vu avant — c'est la PREMIERE fois qu'il verra un rapport
3. NE DIS PAS "le rapport est déjà là" ou "voir ci-dessus" — le user ne voit RIEN avant ce message
4. Decris en detail: quels fichiers crees/modifies, les fonctionnalites, les choix techniques
5. MAIS: NE RECOPIE PAS de blocs de code source. Ton rapport est une DESCRIPTION, pas du code
6. REPONDS RAPIDEMENT — le user attend. Synthetise et envoie
7. Pour les TABLEAUX: utilise la syntaxe markdown avec pipes |${opusSection}\n\n${reportsBody}`;

    flog.info('ORCH', `Delivering combined report to Opus (${this.pendingReports.size} delegates)`);

    // Mute and interrupt delivered agents
    for (const delegate of this.expectedDelegates) {
      this.deliveredToOpus.add(delegate);
      const agent = this.deps.agents[delegate];
      if (agent.mute) {
        agent.mute();
        flog.info('ORCH', `Muted ${delegate} after combined delivery`);
      }
      if (agent.interruptCurrentTask) {
        agent.interruptCurrentTask();
        flog.info('ORCH', `Interrupted ${delegate} active turn after combined delivery`);
      }
    }

    // Clear delegate tracking state
    for (const delegate of this.expectedDelegates) {
      this.deps.crossTalk.clearAgent(delegate);
      this.clearSafetyNetTimer(delegate);
    }

    const deliveredAgents = [...this.pendingReports.keys()];
    const deliveredReportsCopy = new Map(this.pendingReports);

    this.expectedDelegates.clear();
    this.pendingReports.clear();
    this.deps.crossTalk.resetCount();
    this.stopHeartbeat();

    // Emit synthetic relay events for UI
    const isMultiDelegate = deliveredAgents.length > 1;
    for (const agent of deliveredAgents) {
      const report = deliveredReportsCopy.get(agent) ?? '';
      const cleanReport = report.replace(/^\[(?:TO|FROM):(?:OPUS|SONNET|CODEX)\]\s*/gi, '').trim();
      let preview: string;
      if (isMultiDelegate) {
        preview =
          cleanReport.length > 80 ? cleanReport.slice(0, 77) + '...' : cleanReport || 'terminé';
      } else {
        preview =
          cleanReport.length > 120 ? cleanReport.slice(0, 117) + '...' : cleanReport || 'terminé';
      }
      this.deps.bus.emit('relay', {
        from: agent,
        to: 'opus',
        content: preview,
        id: randomUUID(),
        timestamp: Date.now(),
        relayCount: 0,
      });
    }

    // Drop Opus buffer — content was already extracted into opusSection
    this.deps.buffers.clearBuffer('opus');

    // Deliver combined message
    this.deps.bus.send({ from: 'system', to: 'opus', content: combined });
  }

  // ── Auto-relay buffer (safety net) ──

  autoRelayBuffer(
    agent: AgentId,
    relayRouter: {
      isRelayTag(line: string): boolean;
      agentsOnRelay: Set<AgentId>;
      relayStartTime: Map<AgentId, number>;
      recordRelay(): void;
    },
  ): void {
    const buffer = this.deps.buffers.getBuffer(agent);
    const textLines = buffer
      .filter((l: OutputLine) => l.type === 'stdout')
      .map((l: OutputLine) => l.text)
      .filter((t: string) => !relayRouter.isRelayTag(t))
      .join('\n')
      .trim();

    if (textLines) {
      flog.info(
        'ORCH',
        `${agent} finished on relay without [TO:OPUS] — auto-relaying ${textLines.length} chars`,
      );
      if (this.expectedDelegates.has(agent)) {
        this.pendingReports.set(agent, textLines);
        flog.info(
          'ORCH',
          `Auto-buffered ${agent} report (${this.pendingReports.size}/${this.expectedDelegates.size})`,
        );
        if (this.pendingReports.size >= this.expectedDelegates.size) {
          this.deliverCombinedReports();
        }
      } else {
        relayRouter.recordRelay();
        this.deps.bus.relay(agent, 'opus', textLines);
      }
    } else {
      const agentInstance = this.deps.agents[agent];
      if (agentInstance.status === 'running') {
        flog.info('ORCH', `${agent} relay buffer empty but agent still RUNNING — NOT failing over`);
        relayRouter.agentsOnRelay.add(agent);
        relayRouter.relayStartTime.set(agent, Date.now());
        return;
      }

      const lastErr = agentInstance.lastError ?? null;
      const placeholder = lastErr ? `(erreur: ${lastErr})` : '(pas de rapport)';
      flog.warn(
        'ORCH',
        `${agent} finished on relay — no buffered text (${placeholder}), status=${agentInstance.status}`,
      );

      const hadExpected = this.expectedDelegates.has(agent);
      const fallback = this.pickFallbackAgent(agent);
      const originalTask = this.lastDelegationContent.get(agent);
      const cb = this.deps.getCallbacks();

      if (fallback === 'opus' && originalTask && hadExpected) {
        flog.info('ORCH', `Both workers unavailable — signaling Opus to handle`);
        this.expectedDelegates.clear();
        this.pendingReports.clear();
        this.deps.bus.send({
          from: 'system',
          to: 'opus',
          content: `[FALLBACK — ${agent} et l'autre agent ont echoue] Fais le travail toi-meme: ${originalTask}`,
        });
        cb?.onAgentOutput(agent, {
          text: `${agent} indisponible — Opus prend le relais`,
          timestamp: Date.now(),
          type: 'info',
        });
      } else if (fallback && fallback !== 'opus' && originalTask && hadExpected) {
        flog.info('ORCH', `Auto-fallback: ${agent} failed → redelegating to ${fallback}`);
        const content = `[FALLBACK — ${agent} a echoue] ${originalTask}`;
        this.expectedDelegates.add(fallback);
        this.deliveredToOpus.delete(fallback);
        relayRouter.agentsOnRelay.add(fallback);
        relayRouter.relayStartTime.set(fallback, Date.now());
        relayRouter.recordRelay();
        this.deps.bus.relay('opus', fallback, content);
        this.lastActivity.set(fallback, Date.now());
        this.lastDelegationContent.set(fallback, content);
        this.resetDelegateTimeout();
        cb?.onAgentOutput(agent, {
          text: `${agent} indisponible — tache transferee a ${fallback}`,
          timestamp: Date.now(),
          type: 'info',
        });
      } else {
        if (hadExpected) {
          this.pendingReports.set(agent, placeholder);
          if (this.pendingReports.size >= this.expectedDelegates.size) {
            this.deliverCombinedReports();
          }
        }
      }
    }

    relayRouter.agentsOnRelay.delete(agent);
    this.deps.buffers.clearBuffer(agent);
    relayRouter.relayStartTime.delete(agent);

    const isWaiting = (() => {
      for (const a of relayRouter.agentsOnRelay) {
        if (a !== 'opus') return true;
      }
      return false;
    })();

    if (!isWaiting && this.expectedDelegates.size === 0) {
      const cb = this.deps.getCallbacks();
      if (cb) this.deps.buffers.flushOpusBuffer(cb);
    }
  }

  // ── Reset ──

  reset(): void {
    this.expectedDelegates.clear();
    this.pendingReports.clear();
    this.deliveredToOpus.clear();
    this.lastDelegationContent.clear();
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();
    this.circuitBreaker.clear();
    this.stopHeartbeat();
  }

  /** Clear all timers (for shutdown) */
  clearAllTimers(): void {
    for (const timer of this.safetyNetTimers.values()) clearTimeout(timer);
    this.safetyNetTimers.clear();
    this.stopHeartbeat();
  }
}
