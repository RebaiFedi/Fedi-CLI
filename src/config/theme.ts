import { AGENT_LABELS, type AgentId } from '../agents/types.js';

export const THEME = {
  text: '#F8FAFC',
  muted: '#94A3B8',
  border: '#64748B',
  panelBorder: '#334155',
  info: '#C4B5FD',
  opus: '#D4A017',
  sonnet: '#60A5FA',
  codex: '#4ADE80',
  userPrefix: '#CBD5E1',
  userBubbleBg: '#1F2937',
  // Action/tool display
  actionIcon: '#64748B',
  actionText: '#94A3B8',
  actionValue: '#CBD5E1',
  codeBlock: '#1E293B',
  codeBorder: '#475569',
  separator: '#334155',
  // Todo panel
  todoSuccess: '#22C55E',
  todoWarning: '#F59E0B',
  todoBg: '#1E293B',
  todoSubtle: '#475569',
  // Agent header accents (dimmer background shade)
  opusDim: '#78350F',
  sonnetDim: '#0C4A6E',
  codexDim: '#14532D',
} as const;

// Agent icons for terminal display (used in status pills only)
export const AGENT_ICONS: Record<AgentId, string> = {
  opus: '●',
  sonnet: '●',
  codex: '●',
};

const AGENT_HEX: Record<AgentId, string> = {
  opus: THEME.opus,
  sonnet: THEME.sonnet,
  codex: THEME.codex,
};

// Chalk named colors aligned to match the THEME hex values visually:
// opus #F59E0B (amber) → yellow, sonnet #38BDF8 (sky blue) → cyan,
// codex #22C55E (green) → green
const AGENT_CHALK_COLOR: Record<AgentId, 'green' | 'yellow' | 'magenta' | 'cyan'> = {
  opus: 'yellow',
  sonnet: 'cyan',
  codex: 'green',
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

export function agentIcon(agent: AgentId): string {
  return AGENT_ICONS[agent] ?? '●';
}
