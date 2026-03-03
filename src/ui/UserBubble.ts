import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { THEME } from '../config/theme.js';
import { INDENT, MAX_READABLE_WIDTH } from '../config/constants.js';
import { wordWrap } from '../rendering/ansi-renderer.js';

export function printUserBubble(text: string): void {
  const termW = process.stdout.columns || 80;
  const bodyIndent = `${INDENT} `;
  const wrapWidth = Math.max(10, Math.min(termW - bodyIndent.length - 2, MAX_READABLE_WIDTH));
  const wrapped = wordWrap(text, wrapWidth, '');

  const formatLine = (line: string): string => {
    const vis = stripAnsi(line).length;
    const clipped = vis > wrapWidth ? line.slice(0, Math.max(0, wrapWidth - 1)) + '…' : line;
    return `${bodyIndent}${chalk.whiteBright(clipped)}`;
  };

  const userLabel = chalk.hex(THEME.userPrefix).bold('You');
  const header = `${bodyIndent}${userLabel}`;

  // Single console.log to avoid Ink ghost lines
  const outputLines: string[] = [];
  outputLines.push('');
  outputLines.push(header);
  for (let i = 0; i < wrapped.length; i++) {
    outputLines.push(formatLine(wrapped[i] ?? ''));
  }
  // Keep one stable visual gap between user and next agent block.
  outputLines.push('');
  console.log(outputLines.join('\n'));
}
