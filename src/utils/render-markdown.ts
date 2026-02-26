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

  const widths = Array.from({ length: colCount }, (_, i) =>
    Math.max(3, ...rows.map((row) => row[i].length)),
  );

  const formatRow = (row: string[]) =>
    `| ${row.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |`;
  const separator = `|-${widths.map((w) => '-'.repeat(w)).join('-|-')}-|`;

  return [
    { text: formatRow(rows[0]), bold: true },
    { text: separator, dim: true },
    ...rows.slice(1).map((row) => ({ text: formatRow(row) })),
  ];
}

export function renderMarkdown(raw: string): StyledLine[] {
  const lines: StyledLine[] = [];
  const rawLines = raw.split('\n');
  let inCodeBlock = false;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    const trimmed = line.trim();

    // Empty line → spacer
    if (!trimmed) {
      lines.push({ text: '' });
      continue;
    }

    // Code block toggle ```
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        // Opening — show language tag if present
        const lang = trimmed.slice(3).trim();
        lines.push({
          text: lang
            ? `── ${lang} ──────────────────────────`
            : '──────────────────────────────────',
          dim: true,
        });
      } else {
        // Closing
        lines.push({ text: '──────────────────────────────────', dim: true });
      }
      continue;
    }

    // Inside code block — preserve as-is with code flag
    if (inCodeBlock) {
      lines.push({ text: line, code: true });
      continue;
    }

    // Horizontal rule ---
    if (/^[-]{3,}$/.test(trimmed) || /^[*]{3,}$/.test(trimmed)) {
      lines.push({ text: '─────────────────────────────────────', dim: true });
      continue;
    }

    // # H1
    const h1 = trimmed.match(/^#\s+(.+)/);
    if (h1) {
      lines.push({ text: clean(h1[1]).toUpperCase(), bold: true, color: 'cyan' });
      continue;
    }

    // ## H2
    const h2 = trimmed.match(/^##\s+(.+)/);
    if (h2) {
      lines.push({ text: clean(h2[1]), bold: true, color: 'white' });
      continue;
    }

    // ### H3
    const h3 = trimmed.match(/^###\s+(.+)/);
    if (h3) {
      lines.push({ text: clean(h3[1]), bold: true, color: 'gray' });
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
      continue;
    }

    // Blockquote > text
    const blockquote = trimmed.match(/^>\s*(.*)/);
    if (blockquote) {
      lines.push({ text: `  ${clean(blockquote[1])}`, dim: false });
      continue;
    }

    // Bullet list - or *
    const bullet = trimmed.match(/^[-*]\s+(.+)/);
    if (bullet) {
      lines.push({ text: `› ${clean(bullet[1])}` });
      continue;
    }

    // Numbered list
    const numbered = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numbered) {
      lines.push({ text: `${numbered[1]}. ${clean(numbered[2])}` });
      continue;
    }

    // Table row | ... |
    if (/^\|/.test(trimmed)) {
      if (/^\|[\s-:|]+\|$/.test(trimmed)) {
        lines.push({ text: trimmed.replace(/-/g, '─'), dim: true });
      } else {
        lines.push({ text: clean(trimmed) });
      }
      continue;
    }

    // Bold line (like "**Section title:**")
    if (/^\*\*.+\*\*/.test(trimmed) && !trimmed.startsWith('-')) {
      lines.push({ text: clean(trimmed), bold: true, color: 'white' });
      continue;
    }

    // Regular text
    lines.push({ text: clean(trimmed) });
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
    .replace(/_(.+?)_/g, '\x1b[3m$1\x1b[23m') // _italic_ → ANSI italic
    .replace(/`(.+?)`/g, '\x1b[33m$1\x1b[39m'); // `code` → yellow
}
