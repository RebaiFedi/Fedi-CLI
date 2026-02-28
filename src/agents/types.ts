import { z } from 'zod';

// ── Agent identifiers ──────────────────────────────────────────────────────

export type AgentId = 'claude' | 'codex' | 'opus';

export const AGENT_LABELS: Record<AgentId, string> = {
  opus: 'Opus',
  claude: 'Sonnet',
  codex: 'Codex',
};

// ── Agent status ────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

// ── Inter-agent message ─────────────────────────────────────────────────────

export const MessageSchema = z.object({
  id: z.string(),
  from: z.enum(['claude', 'codex', 'opus', 'user', 'system']),
  to: z.enum(['claude', 'codex', 'opus', 'all']),
  content: z.string(),
  correlationId: z.string().optional(),
  relayCount: z.number().default(0),
  timestamp: z.number(),
});

export type Message = z.infer<typeof MessageSchema>;

export const MAX_RELAY_DEPTH = 5;

// ── Agent output line ───────────────────────────────────────────────────────

export interface OutputLine {
  text: string;
  timestamp: number;
  type: 'stdout' | 'stderr' | 'system' | 'relay' | 'info';
}

// ── Session config ──────────────────────────────────────────────────────────

export interface SessionConfig {
  projectDir: string;
  task: string;
  claudePath: string;
  codexPath: string;
}

// ── Agent process interface ─────────────────────────────────────────────────

export interface AgentProcess {
  readonly id: AgentId;
  status: AgentStatus;
  /** Last API error message — used by orchestrator for auto-relay placeholders */
  lastError: string | null;
  send(prompt: string): void;
  /** Inject a message directly into the agent's stdin without changing status.
   *  Used for LIVE user messages and cross-talk while the agent is running. */
  sendUrgent(prompt: string): void;
  start(config: SessionConfig, systemPrompt: string, options?: { muted?: boolean }): Promise<void>;
  stop(): Promise<void>;
  onOutput(handler: (line: OutputLine) => void): void;
  onStatusChange(handler: (status: AgentStatus) => void): void;
  getSessionId(): string | null;
  setContextReminder?(reminder: string): void;
  mute?(): void;
}

// ── Session persistence (v2) ────────────────────────────────────────────────

export interface SessionData {
  id: string;
  version: 2;
  task: string;
  projectDir: string;
  startedAt: number;
  finishedAt?: number;
  messages: Message[];
  agentSessions: {
    opus?: string;
    claude?: string;
    codex?: string;
  };
}

// ── Chat message (unified view) ─────────────────────────────────────────────

export interface DisplayEntry {
  text: string;
  kind: 'text' | 'action' | 'heading' | 'separator' | 'empty' | 'code' | 'info';
  bold?: boolean;
  color?: string;
}

export interface ChatMessage {
  id: string;
  agent: 'claude' | 'codex' | 'opus' | 'user' | 'system';
  lines: DisplayEntry[];
  timestamp: number;
  status: 'streaming' | 'done';
}

// ── Relay pattern detection ─────────────────────────────────────────────────

// Relay directives must be standalone command lines to avoid false positives
// from explanatory text that merely mentions "[TO:*]" patterns.
// Content can follow on the same line OR on subsequent lines (Codex puts content on next line).
export const TO_CLAUDE_PATTERN = /^\s*\[TO:CLAUDE\]\s*(.*?)\s*$/;
export const TO_CODEX_PATTERN = /^\s*\[TO:CODEX\]\s*(.*?)\s*$/;
export const TO_OPUS_PATTERN = /^\s*\[TO:OPUS\]\s*(.*?)\s*$/;
