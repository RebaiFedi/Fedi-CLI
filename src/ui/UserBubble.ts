import chalk from 'chalk';
import { stripAnsi } from '../utils/strip-ansi.js';
import { THEME } from '../config/theme.js';
import { BUBBLE_SIDE_MARGIN, MAX_READABLE_WIDTH } from '../config/constants.js';
import { wordWrap } from '../rendering/ansi-renderer.js';

export function printUserBubble(text: string): void {
  const termW = process.stdout.columns || 80;
  const margin = Math.max(BUBBLE_SIDE_MARGIN, 1);
  const bubbleWidth = Math.max(20, termW - margin * 2);
  const wrapWidth = Math.max(10, Math.min(bubbleWidth - 4, MAX_READABLE_WIDTH));
  const wrapped = wordWrap(text, wrapWidth, '');

  const formatBg = (line: string): string => {
    const visible = stripAnsi(line).length;
    const pad = Math.max(0, bubbleWidth - visible);
    const side = ' '.repeat(margin);
    return `${side}${chalk.bgHex(THEME.userBubbleBg)(line + ' '.repeat(pad))}`;
  };

  const userPrefix = chalk.hex(THEME.userPrefix)(' \u276F ');
  const side = ' '.repeat(margin);
  const emptyBg = `${side}${chalk.bgHex(THEME.userBubbleBg)(' '.repeat(bubbleWidth))}`;

  // Single console.log to avoid Ink ghost lines
  const outputLines: string[] = [''];
  outputLines.push(emptyBg);
  outputLines.push(formatBg(`${userPrefix}${chalk.hex(THEME.text)(wrapped[0] || '')}`));
  for (let i = 1; i < wrapped.length; i++) {
    outputLines.push(formatBg(`    ${chalk.hex(THEME.text)(wrapped[i] ?? '')}`));
  }
  outputLines.push(emptyBg);
  outputLines.push('');
  console.log(outputLines.join('\n'));
}
