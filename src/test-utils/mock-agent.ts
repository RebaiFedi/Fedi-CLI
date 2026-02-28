import type { AgentProcess, AgentId, AgentStatus, OutputLine, SessionConfig } from '../agents/types.js';

/**
 * MockAgent implements AgentProcess without spawning any process.
 * Used for testing the orchestrator in isolation.
 */
export class MockAgent implements AgentProcess {
  readonly id: AgentId;
  status: AgentStatus = 'idle';
  lastError: string | null = null;

  private outputHandlers: Array<(line: OutputLine) => void> = [];
  private statusHandlers: Array<(status: AgentStatus) => void> = [];
  private sentMessages: string[] = [];
  private urgentMessages: string[] = [];
  private _started = false;
  private _muted = false;
  private _interrupted = false;
  private contextReminder: string = '';

  constructor(id: AgentId) {
    this.id = id;
  }

  // ── AgentProcess interface ──────────────────────────────────────────────

  send(prompt: string): void {
    this.sentMessages.push(prompt);
    this.setStatus('running');
  }

  sendUrgent(prompt: string): void {
    this.urgentMessages.push(prompt);
  }

  async start(_config: SessionConfig, _systemPrompt: string, _options?: Record<string, unknown>): Promise<void> {
    this._started = true;
    // Set status to idle — NOT waiting, because 'waiting' triggers the
    // orchestrator's safety-net auto-relay logic for agents on relay.
    this.status = 'idle';
  }

  async stop(): Promise<void> {
    this.setStatus('stopped');
  }

  onOutput(handler: (line: OutputLine) => void): void {
    this.outputHandlers.push(handler);
  }

  onStatusChange(handler: (status: AgentStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  getSessionId(): string | null {
    return this._started ? `mock-session-${this.id}` : null;
  }

  setContextReminder(reminder: string): void {
    this.contextReminder = reminder;
  }

  mute(): void { this._muted = true; }
  isMuted(): boolean { return this._muted; }

  interruptCurrentTask(): void { this._interrupted = true; }
  isInterrupted(): boolean { return this._interrupted; }

  // ── Test control methods ────────────────────────────────────────────────

  /** Emit a text output line (stdout) */
  emitText(text: string): void {
    const line: OutputLine = { text, timestamp: Date.now(), type: 'stdout' };
    for (const h of this.outputHandlers) h(line);
  }

  /** Emit an action output line (system) */
  emitAction(text: string): void {
    const line: OutputLine = { text, timestamp: Date.now(), type: 'system' };
    for (const h of this.outputHandlers) h(line);
  }

  /** Emit an info output line */
  emitInfo(text: string): void {
    const line: OutputLine = { text, timestamp: Date.now(), type: 'info' };
    for (const h of this.outputHandlers) h(line);
  }

  /** Change status and notify handlers */
  setStatus(s: AgentStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  // ── Test inspection methods ─────────────────────────────────────────────

  /** All messages sent via send() */
  getSentMessages(): string[] {
    return [...this.sentMessages];
  }

  /** All messages sent via sendUrgent() */
  getUrgentMessages(): string[] {
    return [...this.urgentMessages];
  }

  /** Whether start() was called */
  isStarted(): boolean {
    return this._started;
  }

  /** Get the stored context reminder */
  getContextReminder(): string {
    return this.contextReminder;
  }

  /** Clear all recorded messages */
  clearMessages(): void {
    this.sentMessages = [];
    this.urgentMessages = [];
  }
}
