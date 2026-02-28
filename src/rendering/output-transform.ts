import type { DisplayEntry, OutputLine } from '../agents/types.js';
import { renderMarkdown } from '../utils/render-markdown.js';

// ── Filters ─────────────────────────────────────────────────────────────────

export const TOOL_RE =
  /^\s*(EnterPlanMode|AskUserQuestion|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookEdit|EnterWorktree|WebSearch|WebFetch)\s*$/;
export const RELAY_PREFIX_RE = /\[(TO|FROM):(CLAUDE|CODEX|OPUS)\]\s*/i;
export const RELAY_LINE_RE = /^\s*\[TO:(CLAUDE|CODEX|OPUS)\]\s/i;
export const TASK_DONE_RE = /\[TASK:done\]\s*(.+)/i;
export const TASK_TAG_LINE_RE = /^\s*\[TASK:(add|done)\]\s*/i;
export const CMD_OUTPUT_HEADER_RE = /^={3,}\s*.+\s*={3,}$/;

// ── OutputLine → DisplayEntry[] ─────────────────────────────────────────────

export function outputToEntries(line: OutputLine): DisplayEntry[] {
  if (line.type === 'system') return [{ text: line.text, kind: 'action' }];
  if (line.type === 'info') return [{ text: line.text, kind: 'info' }];
  if (line.type === 'relay') return [];

  const filteredText = line.text
    .split('\n')
    .filter((l) => !RELAY_LINE_RE.test(l))
    .filter((l) => !TASK_TAG_LINE_RE.test(l))
    .filter((l) => !CMD_OUTPUT_HEADER_RE.test(l.trim()))
    .map((l) => l.replace(RELAY_PREFIX_RE, ''))
    .join('\n');

  if (!filteredText.trim()) return [];

  const styled = renderMarkdown(filteredText);
  const entries: DisplayEntry[] = [];
  for (const s of styled) {
    if (!s.text.trim() && !s.code) {
      entries.push({ text: '', kind: 'empty' });
    } else if (s.code) {
      entries.push({ text: s.text, kind: 'code' });
    } else if (s.dim) {
      entries.push({ text: s.text, kind: 'separator' });
    } else if (s.bold && s.color === 'cyan') {
      entries.push({ text: s.text, kind: 'heading', bold: true, color: 'cyan' });
    } else if (s.bold && s.color === 'white') {
      entries.push({ text: s.text, kind: 'heading', bold: true, color: 'white' });
    } else if (s.bold) {
      entries.push({ text: s.text, kind: 'heading', bold: true });
    } else {
      entries.push({ text: s.text, kind: 'text' });
    }
  }
  return entries.filter((e) => e.kind !== 'text' || !TOOL_RE.test(e.text));
}

// ── Extract tasks & plan ────────────────────────────────────────────────────

/** Clean extracted task text — strip prompt/syntax junk that leaks through */
function cleanTaskText(raw: string): string {
  let t = raw.trim();
  // Truncate at the next [TASK:...] or [TO:...] or [FROM:...] tag if Opus put multiple on one line
  t = t.replace(/\s*\[(TASK|TO|FROM):[^\]]*\].*$/i, '');
  // Strip markdown/code artifacts
  t = t.replace(/`/g, '');
  // Strip relay tags that leaked
  t = t.replace(/\[(TO|FROM):(CLAUDE|CODEX|OPUS)\]/gi, '');
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  // Cap length — no todo should be > 80 chars
  if (t.length > 80) t = t.slice(0, 77) + '...';
  return t;
}

export function extractTasks(text: string): { adds: string[]; dones: string[] } {
  const adds: string[] = [];
  const dones: string[] = [];
  for (const line of text.split('\n')) {
    // Handle multiple [TASK:add] on the same line (Opus sometimes does this)
    const addMatches = line.matchAll(/\[TASK:add\]\s*(.+?)(?=\s*\[TASK:|$)/gi);
    for (const m of addMatches) {
      const cleaned = cleanTaskText(m[1]);
      if (cleaned.length > 3) adds.push(cleaned);
    }
    const doneMatch = line.match(TASK_DONE_RE);
    if (doneMatch) {
      const cleaned = cleanTaskText(doneMatch[1]);
      if (cleaned.length > 3) dones.push(cleaned);
    }
  }
  return { adds, dones };
}
