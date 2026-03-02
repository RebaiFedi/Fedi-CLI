import React, { useMemo, useState, useCallback } from 'react';
import { Text, useInput, type Key } from 'ink';
import chalk from 'chalk';

interface LineInputProps {
  value: string;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
  /** Optional badge displayed inline before the input text (e.g. "[Pasted text +50 lines]") */
  prefixBadge?: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** Called when a paste is detected (multi-line or large input chunk) */
  onPaste?: (text: string) => void;
  /** Called when up arrow is pressed (for history navigation) */
  onHistoryPrev?: () => void;
  /** Called when down arrow is pressed (for history navigation) */
  onHistoryNext?: () => void;
  /** Called when Escape or Ctrl+L is pressed — clear input and paste */
  onClear?: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function LineInput({
  value,
  placeholder = '',
  focus = true,
  showCursor = true,
  prefixBadge,
  onChange,
  onSubmit,
  onPaste,
  onHistoryPrev,
  onHistoryNext,
  onClear,
}: LineInputProps) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const [prevValue, setPrevValue] = useState(value);

  // Keep cursor in sync when value is replaced externally (e.g. history nav)
  // Using derived state pattern — no refs, no effects needed
  if (value !== prevValue) {
    setPrevValue(value);
    setCursorOffset(value.length);
  }

  const safeOffset = Math.max(0, Math.min(cursorOffset, value.length));

  // ── Key handler ────────────────────────────────────────────────────────────
  useInput(
    useCallback(
      (input: string, key: Key) => {
        if (key.ctrl && input === 'c') return;

        // ── Clear all (Escape or Ctrl+L) ──
        if (key.escape || (key.ctrl && input === 'l')) {
          onChange('');
          setCursorOffset(0);
          onClear?.();
          return;
        }

        // ── Submit ──
        if (key.return) {
          onSubmit?.(value);
          return;
        }

        // ── History (up/down) ──
        if (key.upArrow) {
          onHistoryPrev?.();
          return;
        }
        if (key.downArrow) {
          onHistoryNext?.();
          return;
        }

        let nextValue = value;
        let nextOffset = safeOffset;

        // ── Navigation ──────────────────────────────────────────────────────
        if (key.leftArrow) {
          if (key.ctrl || key.meta) {
            // Word left
            let i = safeOffset;
            while (i > 0 && /\s/.test(value[i - 1] ?? '')) i--;
            while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--;
            nextOffset = i;
          } else {
            nextOffset = safeOffset - 1;
          }
        } else if (key.rightArrow) {
          if (key.ctrl || key.meta) {
            // Word right
            let i = safeOffset;
            while (i < value.length && /\s/.test(value[i] ?? '')) i++;
            while (i < value.length && !/\s/.test(value[i] ?? '')) i++;
            nextOffset = i;
          } else {
            nextOffset = safeOffset + 1;
          }
        } else if (key.home || (key.ctrl && input === 'a')) {
          nextOffset = 0;
        } else if (key.end || (key.ctrl && input === 'e')) {
          nextOffset = value.length;
        }
        // ── Deletion ────────────────────────────────────────────────────────
        else if (key.backspace || key.delete) {
          if (safeOffset > 0) {
            if (key.ctrl || key.meta) {
              // Delete word left
              let i = safeOffset;
              while (i > 0 && /\s/.test(value[i - 1] ?? '')) i--;
              while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--;
              nextValue = value.slice(0, i) + value.slice(safeOffset);
              nextOffset = i;
            } else {
              nextValue = value.slice(0, safeOffset - 1) + value.slice(safeOffset);
              nextOffset = safeOffset - 1;
            }
          } else {
            // Cursor at 0 — signal for clearPaste
            onChange(value);
            return;
          }
        } else if (key.ctrl && input === 'd') {
          // Forward delete
          if (safeOffset < value.length) {
            nextValue = value.slice(0, safeOffset) + value.slice(safeOffset + 1);
          }
        } else if (key.ctrl && input === 'u') {
          // Delete to start
          nextValue = value.slice(safeOffset);
          nextOffset = 0;
        } else if (key.ctrl && input === 'k') {
          // Delete to end
          nextValue = value.slice(0, safeOffset);
        } else if (key.ctrl && input === 'w') {
          // Delete word back
          if (safeOffset > 0) {
            let i = safeOffset;
            while (i > 0 && /\s/.test(value[i - 1] ?? '')) i--;
            while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--;
            nextValue = value.slice(0, i) + value.slice(safeOffset);
            nextOffset = i;
          }
        }
        // ── Typing ──────────────────────────────────────────────────────────
        else if (input.length > 0 && !key.ctrl && !key.meta) {
          // Detect paste
          const newlineCount = (input.match(/\n/g) ?? []).length;
          if (onPaste && (newlineCount >= 3 || input.length >= 40)) {
            onPaste(input);
            return;
          }
          nextValue = value.slice(0, safeOffset) + input + value.slice(safeOffset);
          nextOffset = safeOffset + input.length;
        } else {
          return;
        }

        nextOffset = Math.max(0, Math.min(nextOffset, nextValue.length));
        setCursorOffset(nextOffset);
        if (nextValue !== value) onChange(nextValue);
      },
      [value, safeOffset, onChange, onSubmit, onPaste, onHistoryPrev, onHistoryNext, onClear],
    ),
    { isActive: focus },
  );

  // ── Render — single line with cursor ─────────────────────────────────────
  const rendered = useMemo(() => {
    // Prefix badge (pasted text)
    const badge = prefixBadge ? chalk.magenta(prefixBadge) + ' ' : '';

    // Empty — show placeholder
    if (value.length === 0) {
      if (placeholder && showCursor && focus) {
        return badge + chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1));
      }
      if (placeholder) return badge + chalk.grey(placeholder);
      if (showCursor && focus) return badge + chalk.inverse(' ');
      return badge;
    }

    // Render text with cursor highlight
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const char = value[i] ?? '';
      out += showCursor && focus && i === safeOffset ? chalk.inverse(char) : char;
    }
    if (showCursor && focus && safeOffset >= value.length) {
      out += chalk.inverse(' ');
    }

    return badge + out;
  }, [value, safeOffset, placeholder, focus, showCursor, prefixBadge]);

  return <Text>{rendered}</Text>;
}
