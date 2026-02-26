import type { DisplayEntry } from '../agents/types.js';
import { stripAnsi } from '../utils/strip-ansi.js';

/**
 * Collapse consecutive actions into summary lines.
 * - 3+ consecutive file reads → "read 3 files"
 * - 3+ other actions → last action + "(+N more)"
 * - 1-2 actions → kept as-is
 */
export function collapseActions(entries: DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  let buf: string[] = [];

  const isRead = (t: string) => /^\s*▸\s*read\s/.test(t);

  const flush = () => {
    if (!buf.length) return;
    if (buf.length === 1) {
      out.push({ text: buf[0].trim(), kind: 'action' });
      buf = [];
      return;
    }
    // 2+ actions → always collapse into a single summary line
    const reads = buf.filter(isRead);
    if (reads.length >= 2 && reads.length === buf.length) {
      out.push({ text: `▸ read ${reads.length} files`, kind: 'action' });
    } else {
      out.push({
        text: `${buf[buf.length - 1].trim()} (+${buf.length - 1} more)`,
        kind: 'action',
      });
    }
    buf = [];
  };

  for (const e of entries) {
    if (e.kind === 'action') buf.push(e.text);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

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
