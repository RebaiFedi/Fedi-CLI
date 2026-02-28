import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout, type Key } from 'ink';
import chalk from 'chalk';

interface LineInputProps {
  value: string;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
  /** If true, Enter adds a newline instead of submitting. Use Ctrl+J or Shift+Enter (if supported) to submit. */
  multiline?: boolean;
  /** Max number of visible lines in the viewport (default: 5) */
  maxVisibleLines?: number;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** Called when up arrow is pressed on the first line (for history navigation) */
  onHistoryPrev?: () => void;
  /** Called when down arrow is pressed on the last line (for history navigation) */
  onHistoryNext?: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function findWordLeft(value: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos;
  while (i > 0 && /\s/.test(value[i - 1] ?? '')) i--;
  while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--;
  return i;
}

function findWordRight(value: string, pos: number): number {
  if (pos >= value.length) return value.length;
  let i = pos;
  while (i < value.length && /\s/.test(value[i] ?? '')) i++;
  while (i < value.length && !/\s/.test(value[i] ?? '')) i++;
  return i;
}

/**
 * Wrap `text` into lines of at most `width` chars.
 * Preserves existing \n breaks, then wraps long lines.
 */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const paragraphs = text.split('\n');
  const result: string[] = [];
  for (const para of paragraphs) {
    if (para.length === 0) {
      result.push('');
      continue;
    }
    let remaining = para;
    while (remaining.length > width) {
      // Try to break at a space near the wrap point
      let breakAt = width;
      for (let i = width; i > width * 0.6; i--) {
        if (remaining[i] === ' ') { breakAt = i; break; }
      }
      result.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).replace(/^ /, '');
    }
    result.push(remaining);
  }
  return result;
}

/**
 * Given a flat cursor offset in the raw string, compute
 * { row, col } in the wrapped lines array.
 */
function cursorToRowCol(
  value: string,
  cursorOffset: number,
  width: number,
): { row: number; col: number; lines: string[] } {
  const lines = wrapText(value, width);
  let remaining = clamp(cursorOffset, 0, value.length);
  for (let row = 0; row < lines.length; row++) {
    const lineLen = lines[row]!.length;
    // +1 for the implicit \n between wrapped/hard lines, except at end
    const segLen = row < lines.length - 1 ? lineLen + 1 : lineLen;
    if (remaining <= lineLen) {
      return { row, col: remaining, lines };
    }
    remaining -= segLen;
  }
  // Fallback: last position
  const lastRow = lines.length - 1;
  return { row: lastRow, col: lines[lastRow]!.length, lines };
}

/**
 * Convert { row, col } back to a flat offset in the raw string.
 */
function rowColToOffset(lines: string[], row: number, col: number): number {
  let offset = 0;
  for (let r = 0; r < row; r++) {
    offset += (lines[r]?.length ?? 0) + 1; // +1 for \n
  }
  return offset + clamp(col, 0, lines[row]?.length ?? 0);
}

// ── Component ────────────────────────────────────────────────────────────────

export function LineInput({
  value,
  placeholder = '',
  focus = true,
  showCursor = true,
  multiline = false,
  maxVisibleLines = 5,
  onChange,
  onSubmit,
  onHistoryPrev,
  onHistoryNext,
}: LineInputProps) {
  const { stdout } = useStdout();
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const [viewportTop, setViewportTop] = useState(0);
  const safeOffset = clamp(cursorOffset, 0, value.length);

  // Keep cursor in sync when value is replaced externally (e.g. history nav)
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (value !== prevValueRef.current) {
      prevValueRef.current = value;
      setCursorOffset(value.length);
      setViewportTop(0);
    }
  }, [value]);

  // Compute terminal width — reserve 5 chars for the prompt prefix (" ❯ ")
  const termWidth = (stdout?.columns ?? 80) - 5;
  const wrapWidth = Math.max(10, termWidth);

  // ── Key handler ────────────────────────────────────────────────────────────
  useInput(
    useCallback(
      (input: string, key: Key) => {
        // Let Ink / app handle these globally
        if ((key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) return;

        // ── Submit ──
        if (key.return) {
          if (multiline) {
            // In multiline mode, Enter inserts a newline
            const next = value.slice(0, safeOffset) + '\n' + value.slice(safeOffset);
            onChange(next);
            setCursorOffset(safeOffset + 1);
          } else {
            onSubmit?.(value);
          }
          return;
        }

        // Ctrl+J = submit always (even in multiline)
        if (key.ctrl && input === 'j') {
          onSubmit?.(value);
          return;
        }

        let nextValue = value;
        let nextOffset = safeOffset;

        // ── Navigation ──────────────────────────────────────────────────────
        if (key.home || (key.ctrl && input === 'a')) {
          // Go to start of current visual line
          const { row, lines } = cursorToRowCol(value, safeOffset, wrapWidth);
          nextOffset = rowColToOffset(lines, row, 0);
        } else if (key.end || (key.ctrl && input === 'e')) {
          // Go to end of current visual line
          const { row, lines } = cursorToRowCol(value, safeOffset, wrapWidth);
          nextOffset = rowColToOffset(lines, row, lines[row]?.length ?? 0);
        } else if (key.leftArrow) {
          if (key.ctrl || key.meta) {
            nextOffset = findWordLeft(value, safeOffset);
          } else {
            nextOffset = safeOffset - 1;
          }
        } else if (key.rightArrow) {
          if (key.ctrl || key.meta) {
            nextOffset = findWordRight(value, safeOffset);
          } else {
            nextOffset = safeOffset + 1;
          }
        } else if (key.upArrow) {
          const { row, col, lines } = cursorToRowCol(value, safeOffset, wrapWidth);
          if (row === 0) {
            // At top of text — delegate to history
            onHistoryPrev?.();
            return;
          }
          // Move up one visual line, keeping column
          const newRow = row - 1;
          const newCol = clamp(col, 0, lines[newRow]?.length ?? 0);
          nextOffset = rowColToOffset(lines, newRow, newCol);
        } else if (key.downArrow) {
          const { row, col, lines } = cursorToRowCol(value, safeOffset, wrapWidth);
          if (row === lines.length - 1) {
            // At bottom of text — delegate to history
            onHistoryNext?.();
            return;
          }
          const newRow = row + 1;
          const newCol = clamp(col, 0, lines[newRow]?.length ?? 0);
          nextOffset = rowColToOffset(lines, newRow, newCol);
        }
        // ── Deletion ────────────────────────────────────────────────────────
        else if (key.backspace) {
          if (safeOffset > 0) {
            if (key.ctrl || key.meta) {
              const wordStart = findWordLeft(value, safeOffset);
              nextValue = value.slice(0, wordStart) + value.slice(safeOffset);
              nextOffset = wordStart;
            } else {
              nextValue = value.slice(0, safeOffset - 1) + value.slice(safeOffset);
              nextOffset = safeOffset - 1;
            }
          }
        } else if (key.delete) {
          if (safeOffset < value.length) {
            nextValue = value.slice(0, safeOffset) + value.slice(safeOffset + 1);
          }
        } else if (key.ctrl && input === 'w') {
          if (safeOffset > 0) {
            const wordStart = findWordLeft(value, safeOffset);
            nextValue = value.slice(0, wordStart) + value.slice(safeOffset);
            nextOffset = wordStart;
          }
        } else if (key.ctrl && input === 'u') {
          if (safeOffset > 0) {
            nextValue = value.slice(safeOffset);
            nextOffset = 0;
          }
        } else if (key.ctrl && input === 'k') {
          if (safeOffset < value.length) {
            nextValue = value.slice(0, safeOffset);
          }
        }
        // ── Typing ──────────────────────────────────────────────────────────
        else if (input.length > 0 && !key.ctrl && !key.meta) {
          nextValue = value.slice(0, safeOffset) + input + value.slice(safeOffset);
          nextOffset = safeOffset + input.length;
        } else {
          return; // unhandled key, do nothing
        }

        nextOffset = clamp(nextOffset, 0, nextValue.length);
        setCursorOffset(nextOffset);
        if (nextValue !== value) onChange(nextValue);

        // ── Viewport scroll ──────────────────────────────────────────────────
        // After any cursor move, ensure the cursor row is visible
        const { row: newCursorRow } = cursorToRowCol(nextValue, nextOffset, wrapWidth);
        setViewportTop((top) => {
          if (newCursorRow < top) return newCursorRow;
          if (newCursorRow >= top + maxVisibleLines) return newCursorRow - maxVisibleLines + 1;
          return top;
        });
      },
      [value, safeOffset, wrapWidth, multiline, maxVisibleLines, onChange, onSubmit, onHistoryPrev, onHistoryNext],
    ),
    { isActive: focus },
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  const renderedLines = useMemo(() => {
    const { row: cursorRow, col: cursorCol, lines } = cursorToRowCol(value, safeOffset, wrapWidth);

    // Compute visible slice
    const totalLines = lines.length;
    const safeTop = clamp(viewportTop, 0, Math.max(0, totalLines - maxVisibleLines));
    const visibleLines = lines.slice(safeTop, safeTop + maxVisibleLines);
    const scrollIndicatorTop = safeTop > 0;
    const scrollIndicatorBottom = safeTop + maxVisibleLines < totalLines;

    // Build rendered strings
    if (!showCursor || !focus) {
      if (value.length === 0 && placeholder) {
        return [chalk.grey(placeholder)];
      }
      return visibleLines;
    }

    // Show placeholder when empty
    if (value.length === 0) {
      if (!placeholder) return [chalk.inverse(' ')];
      return [chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))];
    }

    return visibleLines.map((line, vi) => {
      const lineIdx = safeTop + vi;
      if (lineIdx !== cursorRow) {
        // Non-cursor line — add scroll indicator
        let out = line;
        if (vi === 0 && scrollIndicatorTop) out = chalk.dim('↑') + out;
        if (vi === visibleLines.length - 1 && scrollIndicatorBottom) out = out + chalk.dim('↓');
        return out;
      }
      // Cursor is on this line — render with cursor highlight
      let out = '';
      for (let i = 0; i < line.length; i++) {
        const char = line[i] ?? '';
        out += i === cursorCol ? chalk.inverse(char) : char;
      }
      if (cursorCol >= line.length) out += chalk.inverse(' ');
      // Scroll indicators
      if (vi === 0 && scrollIndicatorTop) out = chalk.dim('↑') + out;
      if (vi === visibleLines.length - 1 && scrollIndicatorBottom) out = out + chalk.dim('↓');
      return out;
    });
  }, [value, safeOffset, wrapWidth, viewportTop, maxVisibleLines, placeholder, focus, showCursor]);

  if (renderedLines.length === 1) {
    return <Text>{renderedLines[0]}</Text>;
  }

  return (
    <Box flexDirection="column">
      {renderedLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
