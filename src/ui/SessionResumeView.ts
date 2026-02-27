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
    gemini: {
      label: 'Gemini',
      color: chalk.hex(THEME.gemini),
      dot: chalk.hex(THEME.gemini)(DOT_ACTIVE),
    },
    user: { label: 'User', color: chalk.hex(THEME.text), dot: chalk.hex(THEME.text)('\u276F') },
  };

  console.log(
    chalk.dim('  \u2500\u2500\u2500 Session reprise: ') +
      chalk.hex(THEME.claude)(matchId.slice(0, 8)) +
      chalk.dim(' \u2500\u2500\u2500'),
  );
  console.log(chalk.dim(`  Tache: ${session.task}`));
  console.log('');

  const recentMsgs = session.messages.slice(-10);
  for (const msg of recentMsgs) {
    const meta = agentMeta[msg.from] ?? {
      label: msg.from,
      color: chalk.white,
      dot: chalk.dim('\u00B7'),
    };
    const content = msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content;
    if (msg.from === 'user') {
      console.log(`  ${chalk.dim('\u276F')}  ${chalk.white(content)}`);
    } else {
      console.log(`  ${meta.dot} ${chalk.bold(meta.color(meta.label))}`);
      console.log(`${INDENT}${chalk.dim(content)}`);
    }
  }

  console.log('');
  console.log(chalk.dim('  \u2500\u2500\u2500 Fin historique \u2500\u2500\u2500'));
  console.log('');
}

export function buildResumePrompt(session: SessionData): string {
  const agentMeta: Record<string, string> = {
    opus: 'Opus',
    claude: 'Sonnet',
    codex: 'Codex',
    gemini: 'Gemini',
    user: 'User',
  };

  const contextLines = session.messages.slice(-5).map((m) => {
    const label = agentMeta[m.from] ?? m.from;
    const target = agentMeta[m.to] ?? m.to;
    const short = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
    return `[${label}->${target}] ${short}`;
  });

  return `SESSION REPRISE \u2014 Voici le contexte de la session precedente:\n\nTACHE ORIGINALE: ${session.task}\n\n--- HISTORIQUE ---\n${contextLines.join('\n')}\n--- FIN ---\n\nLa session reprend. Attends le prochain message du user.`;
}
