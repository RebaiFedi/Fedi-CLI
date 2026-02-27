import chalk from 'chalk';
import { THEME } from '../config/theme.js';
import { stripAnsi } from '../utils/strip-ansi.js';

export function printWelcomeBanner(projectDir: string): void {
  const dir = projectDir.replace(/^\/home\/[^/]+\//, '~/');

  const line1 = `  ${chalk.hex(THEME.text).bold('>_ Fedi Cli')} ${chalk.dim('(v1.0)')}`;
  const line2 = '';
  const line3 = `  ${chalk.dim('agents:')}     ${chalk.hex(THEME.opus)('Opus')} ${chalk.dim('(Director)')}, ${chalk.hex(THEME.claude)('Sonnet')} ${chalk.dim('(Code)')}, ${chalk.hex(THEME.codex)('Codex')} ${chalk.dim('(Script)')}`;
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

  console.log('');
  console.log(chalk.hex(THEME.border)('  \u256D' + '\u2500'.repeat(inner) + '\u256E'));

  console.log(row(line1));
  console.log(row(line2));
  console.log(row(line3));
  console.log(row(line4));

  console.log(chalk.hex(THEME.border)('  \u2570' + '\u2500'.repeat(inner) + '\u256F'));
  console.log('');
  console.log(
    `  ${chalk.white.bold('Tip:')} ${chalk.dim.italic('Type @opus, @sonnet, or @codex to speak directly to an agent.')}`,
  );
  console.log('');
}
