import chalk from 'chalk';
import type { SessionData } from '../agents/types.js';
import { THEME } from '../config/theme.js';
import { INDENT, DOT_ACTIVE } from '../config/constants.js';

export function printSessionResume(session: SessionData, matchId: string): void {
  const agentMeta: Record<string, { label: string; color: (s: string) => string; dot: string }> = {
    opus: { label: 'Opus', color: chalk.hex(THEME.opus), dot: chalk.hex(THEME.opus)(DOT_ACTIVE) },
    claude: {
      label: 'Sonnet',
      color: chalk.hex(THEME.claude),
      dot: chalk.hex(THEME.claude)(DOT_ACTIVE),
    },
    codex: {
      label: 'Codex',
      color: chalk.hex(THEME.codex),
      dot: chalk.hex(THEME.codex)(DOT_ACTIVE),
    },
    user: { label: 'User', color: chalk.hex(THEME.text), dot: chalk.hex(THEME.text)('\u276F') },
  };

  // Single console.log to avoid Ink ghost lines
  const lines: string[] = [
    chalk.dim('  \u2500\u2500\u2500 Session reprise: ') +
      chalk.hex(THEME.claude)(matchId.slice(0, 8)) +
      chalk.dim(' \u2500\u2500\u2500'),
    chalk.dim(`  Tache: ${session.task}`),
    '',
  ];

  const recentMsgs = session.messages.slice(-10);
  for (const msg of recentMsgs) {
    const meta = agentMeta[msg.from] ?? {
      label: msg.from,
      color: chalk.white,
      dot: chalk.dim('\u00B7'),
    };
    const content = msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content;
    if (msg.from === 'user') {
      lines.push(`  ${chalk.dim('\u276F')}  ${chalk.white(content)}`);
    } else {
      lines.push(`  ${meta.dot} ${chalk.bold(meta.color(meta.label))}`);
      lines.push(`${INDENT}${chalk.dim(content)}`);
    }
  }

  lines.push('', chalk.dim('  \u2500\u2500\u2500 Fin historique \u2500\u2500\u2500'), '');
  console.log(lines.join('\n'));
}

export { buildResumePrompt } from '../utils/session-manager.js';
