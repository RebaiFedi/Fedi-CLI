import type { DisplayEntry } from '../agents/types.js';
import stripAnsi from 'strip-ansi';

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
    if (i + 1 >= raw.length) continue;

    const current = raw[i];
    const next = raw[i + 1];

    // Keep headings readable without over-spacing the stream.
    if (next.kind === 'heading' && current.kind !== 'empty' && current.kind !== 'heading') {
      out.push({ text: '', kind: 'empty' });
      continue;
    }

    // Add one gap before entering a tool/action block from plain text.
    if (
      !isToolBlock(current.kind) &&
      isToolBlock(next.kind) &&
      current.kind !== 'empty'
    ) {
      out.push({ text: '', kind: 'empty' });
      continue;
    }

    // Separate consecutive tool invocations to keep blocks readable
    // (e.g. Edit ... then Edit ...).
    if (
      current.kind !== 'empty' &&
      next.kind === 'tool-header'
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
