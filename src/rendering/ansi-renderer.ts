import chalk from 'chalk';
import type { DisplayEntry } from '../agents/types.js';
import { stripAnsi } from '../utils/strip-ansi.js';
import { THEME } from '../config/theme.js';
import { INDENT, MAX_READABLE_WIDTH } from '../config/constants.js';
import { collapseActions, compact, addActionSpacing } from './compact.js';

/**
 * Word-wrap `text` so each line fits within `maxWidth` visible characters.
 * Continuation lines are prefixed with `contIndent`.
 */
export function wordWrap(text: string, maxWidth: number, contIndent: string): string[] {
  const visibleLen = stripAnsi(text).length;
  if (visibleLen <= maxWidth || maxWidth < 10) return [text];

  const words = text.split(/( +)/);
  const lines: string[] = [];
  let currentLine = '';
  let currentVisible = 0;

  for (const word of words) {
    const wordVisible = stripAnsi(word).length;
    if (currentVisible + wordVisible > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      const trimmed = word.replace(/^ +/, '');
      currentLine = trimmed;
      currentVisible = stripAnsi(trimmed).length;
    } else {
      currentLine += word;
      currentVisible += wordVisible;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.map((l, i) => (i === 0 ? l : `${contIndent}${l}`));
}

function isTableLine(text: string): boolean {
  const t = stripAnsi(text).trim();
  return t.startsWith('|') && t.endsWith('|');
}

export function entryToAnsiLines(
  e: DisplayEntry,
  _agentColor: 'green' | 'yellow' | 'magenta',
): string[] {
  const termW = process.stdout.columns || 80;
  const maxW = Math.max(20, Math.min(termW - INDENT.length, MAX_READABLE_WIDTH));
  const wrapW = INDENT.length + maxW;

  if (e.kind === 'empty') return [''];

  if (isTableLine(e.text)) {
    const clipped =
      e.text.length > maxW ? `${e.text.slice(0, Math.max(0, maxW - 1))}\u2026` : e.text;
    if (e.kind === 'separator') return [`${INDENT}${chalk.dim(clipped)}`];
    if (e.kind === 'heading') return [`${INDENT}${chalk.hex(THEME.text).bold(clipped)}`];
    return [`${INDENT}${clipped}`];
  }

  if (e.kind === 'info') {
    const raw = `${INDENT}${chalk.hex(THEME.info)(e.text)}`;
    return wordWrap(raw, wrapW, INDENT);
  }

  if (e.kind === 'action') {
    const raw = `${INDENT}${chalk.dim(e.text)}`;
    return wordWrap(raw, wrapW, INDENT);
  }

  if (e.kind === 'code') {
    const raw = chalk.hex(THEME.info)(e.text);
    return wordWrap(raw, wrapW, INDENT).map((l, i) => (i === 0 ? `${INDENT}${l}` : l));
  }

  if (e.kind === 'separator') {
    const sepText = e.text.length > maxW ? e.text.slice(0, maxW) : e.text;
    return [`${INDENT}${chalk.dim(sepText)}`];
  }

  if (e.kind === 'heading') {
    const col = e.color === 'cyan' ? chalk.hex(THEME.claude) : chalk.hex(THEME.text);
    const raw = col.bold(e.text);
    return wordWrap(raw, maxW, INDENT).map((l, i) => (i === 0 ? `${INDENT}${l}` : l));
  }

  // Regular text — apply subtle coloring
  const styled = chalk.hex('#CBD5E1')(e.text);
  return wordWrap(styled, maxW, INDENT).map((l, i) => (i === 0 ? `${INDENT}${l}` : l));
}

/** Convert entries to ANSI lines with proper spacing around action groups */
export function entriesToAnsiOutputLines(
  entries: DisplayEntry[],
  agentColor: 'green' | 'yellow' | 'magenta',
  prevKind?: DisplayEntry['kind'],
): string[] {
  const withContext: DisplayEntry[] = prevKind
    ? [{ text: '', kind: prevKind }, ...entries]
    : entries;
  const processed = compact(collapseActions(addActionSpacing(withContext)));
  const start = prevKind ? 1 : 0;
  const lines: string[] = [];
  for (let i = start; i < processed.length; i++) {
    lines.push(...entryToAnsiLines(processed[i], agentColor));
  }
  return lines;
}
