import chalk from 'chalk';
import type { DisplayEntry, ToolAction } from '../agents/types.js';
import stripAnsi from 'strip-ansi';
import { THEME } from '../config/theme.js';
import { INDENT, MAX_READABLE_WIDTH } from '../config/constants.js';
import { compact, addActionSpacing } from './compact.js';

/**
 * Word-wrap `text` so each line fits within `maxWidth` visible characters.
 * Continuation lines are prefixed with `contIndent`.
 */
export function wordWrap(text: string, maxWidth: number, contIndent: string): string[] {
  // Handle embedded newlines: split first, wrap each line individually
  if (text.includes('\n')) {
    const parts = text.split('\n');
    const result: string[] = [];
    for (let p = 0; p < parts.length; p++) {
      const wrapped = wordWrapSingleLine(parts[p], maxWidth, contIndent);
      // First part keeps original formatting, subsequent parts get contIndent
      if (p === 0) {
        result.push(...wrapped);
      } else {
        result.push(...wrapped.map((l, i) => (i === 0 ? `${contIndent}${l}` : l)));
      }
    }
    return result;
  }
  return wordWrapSingleLine(text, maxWidth, contIndent);
}

function wordWrapSingleLine(text: string, maxWidth: number, contIndent: string): string[] {
  const visibleLen = stripAnsi(text).length;
  if (visibleLen <= maxWidth || maxWidth < 10) return [text];

  const contIndentLen = stripAnsi(contIndent).length;
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
      // Continuation lines have contIndent prepended, so account for its width
      currentVisible = contIndentLen + stripAnsi(trimmed).length;
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
  return (
    (t.startsWith('|') && t.endsWith('|')) ||
    (t.startsWith('│') && t.endsWith('│')) ||
    t.startsWith('┌') ||
    t.startsWith('├') ||
    t.startsWith('└')
  );
}

// ── Tool icons & colors ─────────────────────────────────────────────────────

export const TOOL_STYLES: Record<ToolAction, { icon: string; label: string; color: string }> = {
  read: { icon: '>', label: 'Read', color: '#38BDF8' },
  write: { icon: '>', label: 'Write', color: '#A78BFA' },
  create: { icon: '+', label: 'Create', color: '#34D399' },
  edit: { icon: '~', label: 'Edit', color: '#FBBF24' },
  delete: { icon: 'x', label: 'Delete', color: '#F87171' },
  bash: { icon: '$', label: 'Exec', color: '#6EE7B7' },
  glob: { icon: '?', label: 'Explore', color: '#93C5FD' },
  grep: { icon: '/', label: 'Grep', color: '#93C5FD' },
  fetch: { icon: '@', label: 'Fetch', color: '#67E8F9' },
  agent: { icon: '*', label: 'Agent', color: '#C4B5FD' },
  todo: { icon: '-', label: 'Todo', color: '#FCD34D' },
  list: { icon: '>', label: 'List', color: '#38BDF8' },
  search: { icon: '?', label: 'Search', color: '#93C5FD' },
};

// ── Action line formatter (fallback for actions without rich meta) ───────────

const ACTION_PATTERNS: Array<{ re: RegExp; tool: ToolAction }> = [
  { re: /^▸\s*read\s+/i, tool: 'read' },
  { re: /^▸\s*write\s+/i, tool: 'write' },
  { re: /^▸\s*create\s+/i, tool: 'create' },
  { re: /^▸\s*edit\s+/i, tool: 'edit' },
  { re: /^▸\s*delete\s+/i, tool: 'delete' },
  { re: /^▸\s*exec\s+/i, tool: 'bash' },
  { re: /^▸\s*search\s+/i, tool: 'glob' },
  { re: /^▸\s*grep\s+/i, tool: 'grep' },
  { re: /^▸\s*list\s+/i, tool: 'list' },
  { re: /^▸\s*/i, tool: 'bash' },
  // Legacy format: "Read · path" or "Bash : command"
  { re: /^(Read|reading|Lire|lecture)\s*[·:]\s*/i, tool: 'read' },
  { re: /^(Glob|glob)\s*[·:]\s*/i, tool: 'glob' },
  { re: /^(Grep|grep)\s*[·:]\s*/i, tool: 'grep' },
  { re: /^(Write|write|Écriture|ecriture)\s*[·:]\s*/i, tool: 'write' },
  { re: /^(Edit|edit|Modifier)\s*[·:]\s*/i, tool: 'edit' },
  { re: /^(Bash|bash|cmd|exec)\s*[·:]\s*/i, tool: 'bash' },
  { re: /^(WebFetch|fetch|Fetch)\s*[·:]\s*/i, tool: 'fetch' },
  { re: /^(Agent|agent)\s*[·:]\s*/i, tool: 'agent' },
  { re: /^(TodoWrite|todo)\s*[·:]\s*/i, tool: 'todo' },
];

function formatActionLine(text: string, maxW: number): string {
  const trimmed = text.trim();

  // Status snippets (✦ prefix) — handled by entryToAnsiLines with word-wrap
  if (trimmed.startsWith('✦ ')) {
    const snippet = trimmed.slice(2);
    return chalk.whiteBright(snippet);
  }

  for (const { re, tool } of ACTION_PATTERNS) {
    if (re.test(trimmed)) {
      const value = trimmed.replace(re, '').trim();
      if (tool === 'agent' && !value) return '';
      const style = TOOL_STYLES[tool];
      const labelStr = chalk.hex(style.color).bold(style.label);
      const short = value.length > maxW - 22 ? value.slice(0, maxW - 25) + '…' : value;
      if (!short) return '';
      return `${labelStr} ${chalk.whiteBright(short)}`;
    }
  }

  // Generic action — dim with left marker
  const short = trimmed.length > maxW - 8 ? trimmed.slice(0, maxW - 11) + '…' : trimmed;
  return chalk.whiteBright(short);
}

// ── Tool header formatter (rich metadata) ────────────────────────────────────

function formatToolHeader(text: string, tool: ToolAction, maxW: number): string[] {
  const style = TOOL_STYLES[tool];
  // Extract the file/command from the raw text (format: "▸ verb path/to/file")
  const detail = text.replace(/^▸\s*\S+\s*/, '').trim();
  if (tool === 'agent' && !detail) return [];
  const short = detail.length > maxW - 22 ? detail.slice(0, maxW - 25) + '…' : detail;

  const label = chalk.hex(style.color).bold(style.label);
  const value = chalk.whiteBright(short);

  return [`${label} ${value}`];
}

// ── Diff line formatters ─────────────────────────────────────────────────────

function formatDiffOld(text: string, maxW: number, lineNum?: number): string {
  const clipped = text.length > maxW - 14 ? text.slice(0, maxW - 17) + '…' : text;
  const numStr = lineNum != null ? chalk.hex('#7F1D1D')(String(lineNum).padStart(4)) + ' ' : '';
  return `${numStr}${chalk.hex('#EF4444')(`- ${clipped}`)}`;
}

function formatDiffNew(text: string, maxW: number, lineNum?: number): string {
  const clipped = text.length > maxW - 14 ? text.slice(0, maxW - 17) + '…' : text;
  const numStr = lineNum != null ? chalk.hex('#14532D')(String(lineNum).padStart(4)) + ' ' : '';
  return `${numStr}${chalk.hex('#22C55E')(`+ ${clipped}`)}`;
}

// ── Entry renderer ───────────────────────────────────────────────────────────

export function entryToAnsiLines(
  e: DisplayEntry,
  _agentColor: 'green' | 'yellow' | 'magenta' | 'cyan',
): string[] {
  const visibleText = stripAnsi(e.text).trim();
  if (!visibleText && e.kind !== 'empty' && e.kind !== 'code' && e.kind !== 'separator') {
    return [];
  }
  const termW = process.stdout.columns || 80;
  const rightMargin = 1;
  const leftPad = `${INDENT} `;
  const maxW = Math.max(20, Math.min(termW - rightMargin - leftPad.length, MAX_READABLE_WIDTH));
  const wrapW = maxW;
  const contIndent = '';
  const withPad = (lines: string[]) => lines.map((l) => `${leftPad}${l}`);

  if (e.kind === 'empty') return [''];

  if (isTableLine(e.text)) {
    const clipped =
      e.text.length > maxW ? `${e.text.slice(0, Math.max(0, maxW - 1))}\u2026` : e.text;
    if (e.kind === 'separator') return withPad([chalk.dim(clipped)]);
    if (e.kind === 'heading') return withPad([chalk.whiteBright.bold(clipped)]);
    return withPad([chalk.whiteBright(clipped)]);
  }

  if (e.kind === 'info') {
    const styled = chalk.hex(THEME.info)(e.text);
    const lines = wordWrap(styled, wrapW, contIndent);
    return withPad(lines);
  }

  // Rich tool header (from toolMeta)
  if (e.kind === 'tool-header') {
    const tool = e.tool ?? 'read';
    return withPad(formatToolHeader(e.text, tool, maxW));
  }

  // Diff lines (with optional line numbers)
  if (e.kind === 'diff-old') {
    return withPad([formatDiffOld(e.text, maxW, e.lineNum)]);
  }
  if (e.kind === 'diff-new') {
    return withPad([formatDiffNew(e.text, maxW, e.lineNum)]);
  }

  // Legacy action (without rich metadata)
  if (e.kind === 'action') {
    // Status snippets (✦) get word-wrapped instead of truncated
    if (e.text.trim().startsWith('✦ ')) {
      const snippet = e.text.trim().slice(2);
      const styled = chalk.whiteBright(snippet);
      const wrapped = wordWrap(styled, wrapW, '');
      return withPad(wrapped);
    }
    const formatted = formatActionLine(e.text, maxW);
    if (!stripAnsi(formatted).trim()) return [];
    return withPad([formatted]);
  }

  if (e.kind === 'code') {
    // Code block: plain aligned text without decorative borders.
    const lines = e.text.split('\n');
    return withPad(lines.map((l) => {
      const visLen = stripAnsi(l).length;
      const clipped = visLen > maxW - 6 ? l.slice(0, maxW - 9) + '…' : l;
      return chalk.hex(THEME.info)(clipped);
    }));
  }

  if (e.kind === 'separator') {
    // No decorative horizontal rules in chat flow.
    return [''];
  }

  if (e.kind === 'heading') {
    const col = e.color === 'cyan' ? chalk.hex(THEME.sonnet) : chalk.whiteBright;
    const headingLines = wordWrap(col.bold(e.text), wrapW, contIndent);
    return withPad(headingLines);
  }

  // Regular text
  const styled = chalk.whiteBright(e.text);
  return withPad(wordWrap(styled, wrapW, contIndent));
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
