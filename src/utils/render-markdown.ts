export interface StyledLine {
  text: string;
  bold?: boolean;
  dim?: boolean;
  color?: string;
  /** 'code' marks lines inside a code block */
  code?: boolean;
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
        lines.push({ text: '' });
        lines.push({ text: lang ? `── ${lang} ──────────────────────────` : '──────────────────────────────────', dim: true });
      } else {
        // Closing
        lines.push({ text: '──────────────────────────────────', dim: true });
        lines.push({ text: '' });
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
      lines.push({ text: '' });
      lines.push({ text: '─────────────────────────────────────', dim: true });
      lines.push({ text: '' });
      continue;
    }

    // # H1
    const h1 = trimmed.match(/^#\s+(.+)/);
    if (h1) {
      lines.push({ text: '' });
      lines.push({ text: clean(h1[1]).toUpperCase(), bold: true, color: 'cyan' });
      lines.push({ text: '' });
      continue;
    }

    // ## H2
    const h2 = trimmed.match(/^##\s+(.+)/);
    if (h2) {
      lines.push({ text: '' });
      lines.push({ text: clean(h2[1]), bold: true, color: 'white' });
      lines.push({ text: '' });
      continue;
    }

    // ### H3
    const h3 = trimmed.match(/^###\s+(.+)/);
    if (h3) {
      lines.push({ text: '' });
      lines.push({ text: clean(h3[1]), bold: true, color: 'gray' });
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

    // Bold line (like "**Section title:**") — add space before it
    if (/^\*\*.+\*\*/.test(trimmed) && !trimmed.startsWith('-')) {
      lines.push({ text: '' });
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

/** Strip inline markdown formatting */
function clean(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/__(.+?)__/g, '$1')        // __bold__
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/_(.+?)_/g, '$1')          // _italic_
    .replace(/~~(.+?)~~/g, '$1')        // ~~strikethrough~~
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [link](url) → link
}
