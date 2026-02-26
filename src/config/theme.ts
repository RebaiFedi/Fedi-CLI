import type { AgentId } from '../agents/types.js';

export const THEME = {
  text: '#F8FAFC',
  muted: '#94A3B8',
  border: '#64748B',
  panelBorder: '#334155',
  info: '#FBBF24',
  opus: '#F59E0B',
  claude: '#38BDF8',
  codex: '#22C55E',
  userPrefix: '#CBD5E1',
  userBubbleBg: '#1F2937',
} as const;

export function agentHex(agent: AgentId): string {
  if (agent === 'opus') return THEME.opus;
  if (agent === 'claude') return THEME.claude;
  return THEME.codex;
}

export function agentDisplayName(agent: AgentId): string {
  if (agent === 'claude') return 'Sonnet';
  if (agent === 'opus') return 'Opus';
  return 'Codex';
}

export function agentChalkColor(agent: AgentId): 'green' | 'yellow' | 'magenta' {
  if (agent === 'opus') return 'magenta';
  if (agent === 'claude') return 'green';
  return 'yellow';
}
