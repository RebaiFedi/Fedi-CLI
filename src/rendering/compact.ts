import type { DisplayEntry } from '../agents/types.js';
import { stripAnsi } from '../utils/strip-ansi.js';

export function compact(entries: DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'empty' && out.length > 0 && out[out.length - 1].kind === 'empty') continue;
    out.push(e);
  }
  while (out.length > 0 && out[0].kind === 'empty') out.shift();
  return out;
}

export function addActionSpacing(raw: DisplayEntry[]): DisplayEntry[] {
  const isToolBlock = (k: string) =>
    k === 'action' || k === 'info' || k === 'tool-header' || k === 'diff-old' || k === 'diff-new';
  const out: DisplayEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push(raw[i]);
    // Add spacing after a tool block ends (last diff line or standalone action)
    if (isToolBlock(raw[i].kind) && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (!isToolBlock(next.kind) && next.kind !== 'empty') {
        out.push({ text: '', kind: 'empty' });
      }
    }
    // Add spacing before a tool block starts
    if (
      i + 1 < raw.length &&
      (raw[i + 1].kind === 'action' || raw[i + 1].kind === 'tool-header') &&
      !isToolBlock(raw[i].kind) &&
      raw[i].kind !== 'empty'
    ) {
      out.push({ text: '', kind: 'empty' });
    }
  }
  return out;
}

export function compactOutputLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = stripAnsi(line).trim();
    const isEmpty = trimmed === '';

    if (isEmpty && out.length > 0) {
      const prevTrimmed = stripAnsi(out[out.length - 1]).trim();
      const prevIsEmpty = prevTrimmed === '';
      // Only collapse consecutive empty lines — preserve paragraph spacing
      if (prevIsEmpty) continue;
    }
    out.push(line);
  }
  return out;
}
