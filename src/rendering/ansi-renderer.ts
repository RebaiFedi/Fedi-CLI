import chalk from 'chalk';
import type { DisplayEntry } from '../agents/types.js';
import { stripAnsi } from '../utils/strip-ansi.js';
import { THEME } from '../config/theme.js';
import { INDENT, MAX_READABLE_WIDTH } from '../config/constants.js';
import { compact, addActionSpacing } from './compact.js';

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
  return (t.startsWith('|') && t.endsWith('|')) ||
         (t.startsWith('│') && t.endsWith('│')) ||
         t.startsWith('┌') || t.startsWith('├') || t.startsWith('└');
}

// ── Action line formatter ────────────────────────────────────────────────────
// Parses "Read · /path/to/file" or "Bash · command" style actions and formats
// them with icon + color to look pro.

const ACTION_PATTERNS: Array<{ re: RegExp; icon: string; label?: string }> = [
  { re: /^(Read|reading|Lire|lecture)\s*[·:·]\s*/i, icon: '  ↳', label: 'Read' },
  { re: /^(Glob|glob)\s*[·:·]\s*/i, icon: '  ↳', label: 'Glob' },
  { re: /^(Grep|grep)\s*[·:·]\s*/i, icon: '  ↳', label: 'Grep' },
  { re: /^(Write|write|Écriture|ecriture)\s*[·:·]\s*/i, icon: '  ↳', label: 'Write' },
  { re: /^(Edit|edit|Modifier)\s*[·:·]\s*/i, icon: '  ↳', label: 'Edit' },
  { re: /^(Bash|bash|cmd|exec)\s*[·:·]\s*/i, icon: '  ↳', label: 'Exec' },
  { re: /^(WebFetch|fetch|Fetch)\s*[·:·]\s*/i, icon: '  ↳', label: 'Fetch' },
  { re: /^(Agent|agent)\s*[·:·]\s*/i, icon: '  ↳', label: 'Agent' },
  { re: /^(TodoWrite|todo)\s*[·:·]\s*/i, icon: '  ↳', label: 'Todo' },
];

function formatActionLine(text: string, maxW: number): string {
  const trimmed = text.trim();

  for (const { re, icon, label } of ACTION_PATTERNS) {
    if (re.test(trimmed)) {
      const value = trimmed.replace(re, '').trim();
      const labelStr = chalk.hex(THEME.actionIcon)(label ?? icon);
      const short = value.length > maxW - 20 ? value.slice(0, maxW - 23) + '…' : value;
      return `${icon} ${labelStr} ${chalk.hex(THEME.actionValue)(short)}`;
    }
  }

  // Generic action — dim with left marker
  const short = trimmed.length > maxW - 6 ? trimmed.slice(0, maxW - 9) + '…' : trimmed;
  return `  ${chalk.dim('↳')} ${chalk.hex(THEME.actionText)(short)}`;
}

// ── Entry renderer ───────────────────────────────────────────────────────────

export function entryToAnsiLines(
  e: DisplayEntry,
  _agentColor: 'green' | 'yellow' | 'magenta' | 'cyan',
): string[] {
  const termW = process.stdout.columns || 80;
  const maxW = Math.max(20, Math.min(termW - INDENT.length, MAX_READABLE_WIDTH));
  const wrapW = INDENT.length + maxW;
  const contIndent = INDENT + '  ';

  if (e.kind === 'empty') return [''];

  if (isTableLine(e.text)) {
    const clipped =
      e.text.length > maxW ? `${e.text.slice(0, Math.max(0, maxW - 1))}\u2026` : e.text;
    if (e.kind === 'separator') return [`${INDENT}${chalk.dim(clipped)}`];
    if (e.kind === 'heading') return [`${INDENT}${chalk.hex(THEME.text).bold(clipped)}`];
    return [`${INDENT}${clipped}`];
  }

  if (e.kind === 'info') {
    const icon = chalk.hex(THEME.info)('▸');
    const raw = `${INDENT}${icon} ${chalk.hex(THEME.info)(e.text)}`;
    return wordWrap(raw, wrapW, contIndent);
  }

  if (e.kind === 'action') {
    const formatted = formatActionLine(e.text, maxW);
    return [`${INDENT}${formatted}`];
  }

  if (e.kind === 'code') {
    // Code block: left border + monospace color
    const border = chalk.hex(THEME.codeBorder)('│');
    const lines = e.text.split('\n');
    return lines.map((l) => {
      const visLen = stripAnsi(l).length;
      const clipped = visLen > maxW - 4 ? l.slice(0, maxW - 7) + '…' : l;
      return `${INDENT}${border} ${chalk.hex(THEME.info)(clipped)}`;
    });
  }

  if (e.kind === 'separator') {
    // Thin horizontal rule
    const width = Math.min(maxW, 48);
    const rule = chalk.hex(THEME.separator)('─'.repeat(width));
    return [`${INDENT}${rule}`];
  }

  if (e.kind === 'heading') {
    const col = e.color === 'cyan' ? chalk.hex(THEME.sonnet) : chalk.hex(THEME.text);
    // Add a subtle leading marker for headings
    const marker = chalk.hex(THEME.muted)('▌ ');
    const raw = `${marker}${col.bold(e.text)}`;
    return wordWrap(raw, maxW, contIndent).map((l, i) => (i === 0 ? `${INDENT}${l}` : l));
  }

  // Regular text
  const styled = chalk.hex('#CBD5E1')(e.text);
  return wordWrap(styled, maxW, contIndent).map((l, i) => (i === 0 ? `${INDENT}${l}` : l));
}

/** Convert entries to ANSI lines with proper spacing around action groups */
export function entriesToAnsiOutputLines(
  entries: DisplayEntry[],
  agentColor: 'green' | 'yellow' | 'magenta' | 'cyan',
  prevKind?: DisplayEntry['kind'],
): string[] {
  const withContext: DisplayEntry[] = prevKind
    ? [{ text: '', kind: prevKind }, ...entries]
    : entries;
  const processed = compact(addActionSpacing(withContext));
  const start = prevKind ? 1 : 0;
  const lines: string[] = [];
  for (let i = start; i < processed.length; i++) {
    lines.push(...entryToAnsiLines(processed[i], agentColor));
  }
  return lines;
}
