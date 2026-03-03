import stripAnsi from 'strip-ansi';

export interface StyledLine {
  text: string;
  bold?: boolean;
  dim?: boolean;
  color?: string;
  /** 'code' marks lines inside a code block */
  code?: boolean;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|');
}

function splitTableRow(line: string): string[] {
  const t = line.trim();
  const inner = t.slice(1, -1);
  return inner.split('|').map((cell) => clean(cell.trim()));
}

function isTableSeparatorRow(line: string): boolean {
  if (!isTableRow(line)) return false;
  const t = line.trim().slice(1, -1);
  const cells = t.split('|').map((c) => c.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isPlainParagraphLine(trimmed: string): boolean {
  if (!trimmed) return false;
  if (/^#{1,6}\s+/.test(trimmed)) return false;
  if (/^```/.test(trimmed)) return false;
  if (/^[-*]\s+/.test(trimmed)) return false;
  if (/^\d+\.\s+/.test(trimmed)) return false;
  if (/^>\s*/.test(trimmed)) return false;
  if (isTableRow(trimmed)) return false;
  return true;
}

/** Pad a string that may contain ANSI codes to a visible width */
function padEndVisible(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  const padding = Math.max(0, width - visible);
  return text + ' '.repeat(padding);
}

function formatTableBlock(block: string[]): StyledLine[] {
  if (block.length < 2 || !isTableSeparatorRow(block[1])) {
    return block.map((r) => ({ text: clean(r.trim()) }));
  }

  const header = splitTableRow(block[0]);
  const bodyRows = block.slice(2).map(splitTableRow);
  const rowData = [header, ...bodyRows];
  const colCount = Math.max(...rowData.map((row) => row.length));

  const normalize = (row: string[]) =>
    Array.from({ length: colCount }, (_, i) => (row[i] ?? '').trim());
  const rows = rowData.map(normalize);

  // Use visible length (strip ANSI) for width calculation
  const widths = Array.from({ length: colCount }, (_, i) =>
    Math.max(3, ...rows.map((row) => stripAnsi(row[i]).length)),
  );

  const makeRow = (row: string[]) =>
    '│ ' + row.map((cell, i) => padEndVisible(cell, widths[i])).join(' │ ') + ' │';
  const makeTopBorder = () =>
    '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const makeMidBorder = () =>
    '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const makeBottomBorder = () =>
    '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const result: StyledLine[] = [];
  result.push({ text: makeTopBorder(), dim: true });
  result.push({ text: makeRow(rows[0]), bold: true });
  result.push({ text: makeMidBorder(), dim: true });
  for (let i = 1; i < rows.length; i++) {
    result.push({ text: makeRow(rows[i]) });
  }
  result.push({ text: makeBottomBorder(), dim: true });
  return result;
}

export function renderMarkdown(raw: string): StyledLine[] {
  const lines: StyledLine[] = [];
  const rawLines = raw.split('\n');
  let inCodeBlock = false;
  let previousPlainLine = '';

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    const trimmed = line.trim();

    // Empty line → spacer
    if (!trimmed) {
      lines.push({ text: '' });
      previousPlainLine = '';
      continue;
    }

    // Code block toggle ```
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        // Opening — add optional language hint without decorative lines.
        const lang = trimmed.slice(3).trim();
        lines.push({ text: '' });
        if (lang) lines.push({ text: `code: ${lang}`, dim: true });
      } else {
        // Closing — keep only spacing.
        lines.push({ text: '' });
      }
      previousPlainLine = '';
      continue;
    }

    // Inside code block — preserve as-is with code flag
    if (inCodeBlock) {
      lines.push({ text: line, code: true });
      previousPlainLine = '';
      continue;
    }

    // Horizontal rule ---
    if (/^[-]{3,}$/.test(trimmed) || /^[*]{3,}$/.test(trimmed)) {
      // In chat flow this line often creates visual noise; keep only spacing.
      lines.push({ text: '' });
      previousPlainLine = '';
      continue;
    }

    // # H1
    const h1 = trimmed.match(/^#\s+(.+)/);
    if (h1) {
      lines.push({ text: clean(h1[1]).toUpperCase(), bold: true, color: 'cyan' });
      previousPlainLine = '';
      continue;
    }

    // ## H2
    const h2 = trimmed.match(/^##\s+(.+)/);
    if (h2) {
      lines.push({ text: clean(h2[1]), bold: true, color: 'white' });
      previousPlainLine = '';
      continue;
    }

    // ### H3
    const h3 = trimmed.match(/^###\s+(.+)/);
    if (h3) {
      lines.push({ text: clean(h3[1]), bold: true, color: 'gray' });
      previousPlainLine = '';
      continue;
    }

    // Markdown table block
    if (
      isTableRow(trimmed) &&
      idx + 1 < rawLines.length &&
      isTableSeparatorRow(rawLines[idx + 1].trim())
    ) {
      const block: string[] = [trimmed];
      let j = idx + 1;
      while (j < rawLines.length && isTableRow(rawLines[j].trim())) {
        block.push(rawLines[j].trim());
        j++;
      }
      lines.push(...formatTableBlock(block));
      idx = j - 1;
      previousPlainLine = '';
      continue;
    }

    // Blockquote > text
    const blockquote = trimmed.match(/^>\s*(.*)/);
    if (blockquote) {
      lines.push({ text: `> ${clean(blockquote[1])}`, dim: false });
      previousPlainLine = '';
      continue;
    }

    // Bullet list - or *
    const bullet = trimmed.match(/^[-*]\s+(.+)/);
    if (bullet) {
      const item = clean(bullet[1]).replace(/^[\s\u00A0\u2000-\u200B]+/, '');
      lines.push({ text: `- ${item}` });
      previousPlainLine = '';
      continue;
    }

    // Numbered list
    const numbered = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numbered) {
      const item = clean(numbered[2]).replace(/^[\s\u00A0\u2000-\u200B]+/, '');
      lines.push({ text: `${numbered[1]}. ${item}` });
      previousPlainLine = '';
      continue;
    }

    // Table row | ... |
    if (/^\|/.test(trimmed)) {
      if (/^\|[\s-:|]+\|$/.test(trimmed)) {
        lines.push({ text: trimmed.replace(/-/g, '─'), dim: true });
      } else {
        lines.push({ text: clean(trimmed) });
      }
      previousPlainLine = '';
      continue;
    }

    // Bold line (like "**Section title:**")
    if (/^\*\*.+\*\*/.test(trimmed) && !trimmed.startsWith('-')) {
      lines.push({ text: clean(trimmed), bold: true, color: 'white' });
      previousPlainLine = '';
      continue;
    }

    // Regular text
    if (
      previousPlainLine &&
      isPlainParagraphLine(previousPlainLine) &&
      isPlainParagraphLine(trimmed) &&
      /[.!?:;]$/.test(previousPlainLine) &&
      previousPlainLine.length >= 40 &&
      trimmed.length >= 40
    ) {
      lines.push({ text: '' });
    }
    lines.push({ text: clean(trimmed) });
    previousPlainLine = trimmed;
  }

  return dedup(lines);
}

function dedup(lines: StyledLine[]): StyledLine[] {
  const out: StyledLine[] = [];
  for (const l of lines) {
    if (!l.text && out.length > 0 && !out[out.length - 1].text) continue;
    out.push(l);
  }
  while (out.length > 0 && !out[0].text) out.shift();
  while (out.length > 0 && !out[out.length - 1].text) out.pop();
  return out;
}

/** Strip inline markdown formatting but keep visual hints via ANSI */
function clean(text: string): string {
  return text
    .replace(/__(.+?)__/g, '$1') // __bold__
    .replace(/~~(.+?)~~/g, '$1') // ~~strikethrough~~
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link](url) → link
    .replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m') // **bold** → ANSI bold
    .replace(/\*(.+?)\*/g, '\x1b[3m$1\x1b[23m') // *italic* → ANSI italic
    .replace(/(?<![a-zA-Z0-9])_([^_]+?)_(?![a-zA-Z0-9])/g, '\x1b[3m$1\x1b[23m') // _italic_ → ANSI italic (not snake_case)
    .replace(/`(.+?)`/g, '\x1b[33m$1\x1b[39m'); // `code` → yellow
}
