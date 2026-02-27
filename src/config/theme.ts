import { AGENT_LABELS, type AgentId } from '../agents/types.js';

export const THEME = {
  text: '#F8FAFC',
  muted: '#94A3B8',
  border: '#64748B',
  panelBorder: '#334155',
  info: '#FBBF24',
  opus: '#F59E0B',
  claude: '#38BDF8',
  codex: '#22C55E',
  gemini: '#A78BFA',
  userPrefix: '#CBD5E1',
  userBubbleBg: '#1F2937',
} as const;

const AGENT_HEX: Record<AgentId, string> = {
  opus: THEME.opus,
  claude: THEME.claude,
  codex: THEME.codex,
  gemini: THEME.gemini,
};

const AGENT_CHALK_COLOR: Record<AgentId, 'green' | 'yellow' | 'magenta' | 'cyan'> = {
  opus: 'magenta',
  claude: 'green',
  codex: 'yellow',
  gemini: 'cyan',
};

export function agentHex(agent: AgentId): string {
  return AGENT_HEX[agent] ?? THEME.codex;
}

export function agentDisplayName(agent: AgentId): string {
  return AGENT_LABELS[agent] ?? agent;
}

export function agentChalkColor(agent: AgentId): 'green' | 'yellow' | 'magenta' | 'cyan' {
  return AGENT_CHALK_COLOR[agent] ?? 'yellow';
}
