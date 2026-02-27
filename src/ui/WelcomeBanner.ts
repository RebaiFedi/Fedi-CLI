import chalk from 'chalk';
import { THEME } from '../config/theme.js';
import { stripAnsi } from '../utils/strip-ansi.js';

export function printWelcomeBanner(projectDir: string): void {
  const dir = projectDir.replace(/^\/home\/[^/]+\//, '~/');

  const line1 = `  ${chalk.hex(THEME.text).bold('>_ Fedi Cli')} ${chalk.dim('(v1.0)')}`;
  const line2 = '';
  const line3 = `  ${chalk.dim('agents:')}     ${chalk.hex(THEME.opus)('Opus')} ${chalk.dim('(Director)')}, ${chalk.hex(THEME.claude)('Sonnet')} ${chalk.dim('(Code)')}, ${chalk.hex(THEME.codex)('Codex')} ${chalk.dim('(Script)')}, ${chalk.hex(THEME.gemini)('Gemini')} ${chalk.dim('(Explorer)')}`;
  const line4 = `  ${chalk.dim('directory:')}  ${chalk.hex(THEME.text)(dir)}`;

  const contentWidth = Math.max(
    stripAnsi(line1).length,
    stripAnsi(line3).length,
    stripAnsi(line4).length,
  );

  const termW = process.stdout.columns || 80;
  const inner = Math.min(contentWidth + 4, termW - 6);

  const row = (content: string) => {
    const visible = stripAnsi(content).length;
    const padding = Math.max(0, inner - visible);
    return (
      chalk.hex(THEME.border)('  \u2502') +
      content +
      ' '.repeat(padding) +
      chalk.hex(THEME.border)('\u2502')
    );
  };

  // Single console.log to avoid Ink ghost lines from multiple erase+redraw cycles
  const output = [
    '',
    chalk.hex(THEME.border)('  \u256D' + '\u2500'.repeat(inner) + '\u256E'),
    row(line1),
    row(line2),
    row(line3),
    row(line4),
    chalk.hex(THEME.border)('  \u2570' + '\u2500'.repeat(inner) + '\u256F'),
    '',
    `  ${chalk.white.bold('Tip:')} ${chalk.dim.italic('Type @opus, @sonnet, @codex, or @gemini to speak directly to an agent.')}`,
    `  ${chalk.dim.italic('       @tous <message> envoie a tous les agents simultanement.')}`,
    `  ${chalk.dim.italic('       @sessions liste vos sessions enregistrees.')}`,
    `  ${chalk.dim.italic('       Esc arrete les agents en cours  |  Ctrl+C quitte.')}`,
    '',
  ].join('\n');
  console.log(output);
}
