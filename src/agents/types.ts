import { z } from 'zod';

// ── Agent identifiers ──────────────────────────────────────────────────────

export type AgentId = 'claude' | 'codex' | 'haiku';

export const AGENT_LABELS: Record<AgentId, string> = {
  haiku: 'Haiku',
  claude: 'Claude Code',
  codex: 'Codex CLI',
};

// ── Agent status ────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

// ── Inter-agent message ─────────────────────────────────────────────────────

export const MessageSchema = z.object({
  id: z.string(),
  from: z.enum(['claude', 'codex', 'haiku', 'user', 'system']),
  to: z.enum(['claude', 'codex', 'haiku', 'all']),
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
  type: 'stdout' | 'stderr' | 'system' | 'relay';
}

// ── Claude stream-json types ────────────────────────────────────────────────

export const ClaudeStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assistant'),
    message: z.object({
      id: z.string(),
      content: z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
      })),
    }),
    session_id: z.string().optional(),
  }),
  z.object({
    type: z.literal('system'),
    subtype: z.string(),
    session_id: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
  }).passthrough(),
]);

export type ClaudeStreamMessage = z.infer<typeof ClaudeStreamMessageSchema>;

// ── Codex response types ────────────────────────────────────────────────────

export const CodexResponseSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  output: z.string().optional(),
  items: z.array(z.any()).optional(),
}).passthrough();

export type CodexResponse = z.infer<typeof CodexResponseSchema>;

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
  send(prompt: string): void;
  start(config: SessionConfig, systemPrompt: string): Promise<void>;
  stop(): Promise<void>;
  onOutput(handler: (line: OutputLine) => void): void;
  onStatusChange(handler: (status: AgentStatus) => void): void;
}

// ── Chat message (unified view) ─────────────────────────────────────────────

export interface DisplayEntry {
  text: string;
  kind: 'text' | 'action' | 'heading' | 'separator' | 'empty' | 'code';
  bold?: boolean;
  color?: string;
}

export interface ChatMessage {
  id: string;
  agent: 'claude' | 'codex' | 'haiku' | 'user' | 'system';
  lines: DisplayEntry[];
  timestamp: number;
  status: 'streaming' | 'done';
}

// ── Relay pattern detection ─────────────────────────────────────────────────

// Relay directives must be standalone command lines to avoid false positives
// from explanatory text that merely mentions "[TO:*]" patterns.
export const TO_CLAUDE_PATTERN = /^\s*\[TO:CLAUDE\]\s+(\S(?:.*\S)?)\s*$/;
export const TO_CODEX_PATTERN = /^\s*\[TO:CODEX\]\s+(\S(?:.*\S)?)\s*$/;
export const TO_HAIKU_PATTERN = /^\s*\[TO:HAIKU\]\s+(\S(?:.*\S)?)\s*$/;
