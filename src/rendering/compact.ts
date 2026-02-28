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
  const isBlock = (k: string) => k === 'action' || k === 'info';
  const out: DisplayEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push(raw[i]);
    if (isBlock(raw[i].kind) && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (!isBlock(next.kind) && next.kind !== 'empty') {
        out.push({ text: '', kind: 'empty' });
      }
    }
    if (
      i + 1 < raw.length &&
      isBlock(raw[i + 1].kind) &&
      !isBlock(raw[i].kind) &&
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
      const nextTrimmed = i + 1 < lines.length ? stripAnsi(lines[i + 1]).trim() : '';
      const prevIsEmpty = prevTrimmed === '';
      const prevIsSeparator = /^[-\u2500]{3,}$/.test(prevTrimmed);
      const nextIsSeparator = /^[-\u2500]{3,}$/.test(nextTrimmed);
      if (prevIsEmpty || prevIsSeparator || nextIsSeparator) continue;
    }
    out.push(line);
  }
  return out;
}
