import chalk from 'chalk';
import { stripAnsi } from '../utils/strip-ansi.js';
import { THEME } from '../config/theme.js';
import { BUBBLE_SIDE_MARGIN, MAX_READABLE_WIDTH } from '../config/constants.js';
import { wordWrap } from '../rendering/ansi-renderer.js';

export function printUserBubble(text: string): void {
  const termW = process.stdout.columns || 80;
  const bubbleWidth = Math.max(20, termW - BUBBLE_SIDE_MARGIN * 2);
  const wrapWidth = Math.max(10, Math.min(bubbleWidth - 3, MAX_READABLE_WIDTH));
  const wrapped = wordWrap(text, wrapWidth, '');

  const formatBg = (line: string): string => {
    const visible = stripAnsi(line).length;
    const pad = Math.max(0, bubbleWidth - visible);
    const margin = ' '.repeat(BUBBLE_SIDE_MARGIN);
    return `${margin}${chalk.bgHex(THEME.userBubbleBg)(line + ' '.repeat(pad))}${margin}`;
  };

  const userPrefix = chalk.hex(THEME.userPrefix)(' \u276F ');
  // Single console.log to avoid Ink ghost lines
  const outputLines: string[] = [''];
  outputLines.push(formatBg(`${userPrefix}${chalk.hex(THEME.text)(wrapped[0] || '')}`));
  for (let i = 1; i < wrapped.length; i++) {
    outputLines.push(formatBg(`   ${chalk.hex(THEME.text)(wrapped[i] ?? '')}`));
  }
  outputLines.push('');
  console.log(outputLines.join('\n'));
}
