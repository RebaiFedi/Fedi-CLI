import chalk from 'chalk';
import type { DisplayEntry, ToolAction } from '../agents/types.js';
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

// ── Tool icons & colors ─────────────────────────────────────────────────────

const TOOL_STYLES: Record<ToolAction, { icon: string; label: string; color: string }> = {
  read:   { icon: '>', label: 'Read',   color: '#38BDF8' },
  write:  { icon: '>', label: 'Write',  color: '#A78BFA' },
  create: { icon: '+', label: 'Create', color: '#34D399' },
  edit:   { icon: '~', label: 'Edit',   color: '#FBBF24' },
  delete: { icon: 'x', label: 'Delete', color: '#F87171' },
  bash:   { icon: '$', label: 'Exec',   color: '#6EE7B7' },
  glob:   { icon: '?', label: 'Search', color: '#93C5FD' },
  grep:   { icon: '/', label: 'Grep',   color: '#93C5FD' },
  fetch:  { icon: '@', label: 'Fetch',  color: '#67E8F9' },
  agent:  { icon: '*', label: 'Agent',  color: '#C4B5FD' },
  todo:   { icon: '-', label: 'Todo',   color: '#FCD34D' },
  list:   { icon: '>', label: 'List',   color: '#38BDF8' },
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

  for (const { re, tool } of ACTION_PATTERNS) {
    if (re.test(trimmed)) {
      const value = trimmed.replace(re, '').trim();
      const style = TOOL_STYLES[tool];
      const labelStr = chalk.hex(style.color).bold(style.label);
      const short = value.length > maxW - 20 ? value.slice(0, maxW - 23) + '…' : value;
      return `  ${chalk.hex(style.color)(style.icon)} ${labelStr} ${chalk.hex(THEME.actionValue)(short)}`;
    }
  }

  // Generic action — dim with left marker
  const short = trimmed.length > maxW - 6 ? trimmed.slice(0, maxW - 9) + '…' : trimmed;
  return `  ${chalk.dim('↳')} ${chalk.hex(THEME.actionText)(short)}`;
}

// ── Tool header formatter (rich metadata) ────────────────────────────────────

function formatToolHeader(text: string, tool: ToolAction, maxW: number): string[] {
  const style = TOOL_STYLES[tool];
  // Extract the file/command from the raw text (format: "▸ verb path/to/file")
  const detail = text.replace(/^▸\s*\S+\s*/, '').trim();
  const short = detail.length > maxW - 20 ? detail.slice(0, maxW - 23) + '…' : detail;

  const icon = chalk.hex(style.color)(style.icon);
  const label = chalk.hex(style.color).bold(style.label);
  const value = chalk.hex('#E2E8F0')(short);

  return [`${INDENT}  ${icon} ${label} ${value}`];
}

// ── Diff line formatters ─────────────────────────────────────────────────────

function formatDiffOld(text: string, maxW: number): string {
  const clipped = text.length > maxW - 8 ? text.slice(0, maxW - 11) + '…' : text;
  const border = chalk.hex('#7F1D1D')('│');
  return `${INDENT}    ${border} ${chalk.hex('#EF4444')(`- ${clipped}`)}`;
}

function formatDiffNew(text: string, maxW: number): string {
  const clipped = text.length > maxW - 8 ? text.slice(0, maxW - 11) + '…' : text;
  const border = chalk.hex('#14532D')('│');
  return `${INDENT}    ${border} ${chalk.hex('#22C55E')(`+ ${clipped}`)}`;
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

  // Rich tool header (from toolMeta)
  if (e.kind === 'tool-header') {
    const tool = e.tool ?? 'read';
    return formatToolHeader(e.text, tool, maxW);
  }

  // Diff lines
  if (e.kind === 'diff-old') {
    return [formatDiffOld(e.text, maxW)];
  }
  if (e.kind === 'diff-new') {
    return [formatDiffNew(e.text, maxW)];
  }

  // Legacy action (without rich metadata)
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
      const clipped = visLen > maxW - 6 ? l.slice(0, maxW - 9) + '…' : l;
      return `${INDENT} ${border} ${chalk.hex(THEME.info)(clipped)}`;
    });
  }

  if (e.kind === 'separator') {
    // Thin horizontal rule — code block delimiters or markdown hr
    const width = Math.min(maxW, 48);
    const rule = chalk.hex(THEME.separator)('─'.repeat(width));
    return [`${INDENT} ${rule}`];
  }

  if (e.kind === 'heading') {
    const col = e.color === 'cyan' ? chalk.hex(THEME.sonnet) : chalk.hex(THEME.text);
    // Add a subtle leading marker for headings
    const marker = chalk.hex(THEME.muted)('▌ ');
    const raw = `${marker}${col.bold(e.text)}`;
    const headingLines = wordWrap(raw, maxW, contIndent).map((l, i) => (i === 0 ? `${INDENT}${l}` : l));
    return ['', ...headingLines];
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
