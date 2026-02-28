import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useStdin } from 'ink';
import { LineInput } from './LineInput.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
}

// A paste is detected when a chunk arrives on stdin that:
//  - Has >= PASTE_MIN_LINES newlines, OR
//  - Has >= PASTE_MIN_CHARS chars AND arrives within PASTE_TIMING_MS of the previous chunk
const PASTE_MIN_LINES = 3;
const PASTE_MIN_CHARS = 40;
const PASTE_TIMING_MS = 20; // chars arriving faster than this = paste burst
const MAX_HISTORY = 50;

function InputBarComponent({ onSubmit, placeholder }: InputBarProps) {
  const [value, setValue] = useState('');
  const [pastedLabel, setPastedLabel] = useState<string | null>(null);
  const fullText = useRef<string>('');
  const pasteCounter = useRef(0);
  const { stdin } = useStdin();
  const lastDataTime = useRef<number>(0);
  const isProcessingPaste = useRef(false);

  // ── Input history ──────────────────────────────────────────────────────────
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');

  const clearPaste = useCallback(() => {
    setPastedLabel(null);
    fullText.current = '';
    isProcessingPaste.current = false;
    setValue('');
  }, []);

  // ── Paste detection via raw stdin ─────────────────────────────────────────
  // We intercept data BEFORE LineInput (ink's useInput) processes it.
  // When we detect a paste: store the text, prevent LineInput from seeing it
  // by marking isProcessingPaste, and show the [Pasted] label.
  useEffect(() => {
    if (!stdin) return;

    const onData = (data: Buffer) => {
      const str = data.toString();
      const now = Date.now();
      const timeSinceLast = now - lastDataTime.current;
      lastDataTime.current = now;

      const lines = str.split('\n').length - 1;
      const isPasteByLines = lines >= PASTE_MIN_LINES;
      const isPasteByTiming = str.length >= PASTE_MIN_CHARS && timeSinceLast < PASTE_TIMING_MS;

      if (isPasteByLines || isPasteByTiming) {
        isProcessingPaste.current = true;
        pasteCounter.current++;
        // Append to existing pasted text if we already have some
        if (fullText.current) {
          fullText.current = fullText.current + str;
        } else {
          fullText.current = str;
        }
        const totalLines = fullText.current.split('\n').length - 1;
        setPastedLabel(`[Pasted text #${pasteCounter.current} — ${totalLines} lines]`);
        // Clear the visible input so LineInput doesn't try to render 500 lines
        setValue('');
      } else {
        // Normal typed char — reset paste processing state
        isProcessingPaste.current = false;
      }
    };

    // Use 'data' listener at priority (prepend) so we run BEFORE ink's useInput
    stdin.prependListener('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin]);

  // ── History navigation (delegated from LineInput) ─────────────────────────
  const handleHistoryPrev = useCallback(() => {
    if (history.current.length === 0) return;
    if (historyIndex.current === -1) {
      savedDraft.current = value;
      historyIndex.current = history.current.length - 1;
    } else if (historyIndex.current > 0) {
      historyIndex.current--;
    }
    const histVal = history.current[historyIndex.current] ?? '';
    setValue(histVal);
  }, [value]);

  const handleHistoryNext = useCallback(() => {
    if (historyIndex.current === -1) return;
    if (historyIndex.current < history.current.length - 1) {
      historyIndex.current++;
      setValue(history.current[historyIndex.current] ?? '');
    } else {
      historyIndex.current = -1;
      setValue(savedDraft.current);
    }
  }, []);

  // ── Change handler ────────────────────────────────────────────────────────
  const handleChange = useCallback(
    (text: string) => {
      // If we're in the middle of processing a paste, ignore LineInput's onChange
      // (it would be trying to set the pasted text as the field value)
      if (isProcessingPaste.current) return;

      // Backspace on empty = clear paste
      if (pastedLabel && text.length === 0 && value.length === 0) {
        clearPaste();
        return;
      }

      setValue(text);
      historyIndex.current = -1;
    },
    [pastedLabel, clearPaste, value],
  );

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    (text: string) => {
      const extra = value.trim();
      const pasted = fullText.current.trim();
      const toSend = pasted ? (extra ? `${pasted}\n\n${extra}` : pasted) : text;
      if (!toSend.trim()) return;

      const msg = toSend.trim();
      if (
        msg &&
        (history.current.length === 0 || history.current[history.current.length - 1] !== msg)
      ) {
        history.current.push(msg);
        if (history.current.length > MAX_HISTORY) {
          history.current.shift();
        }
      }
      historyIndex.current = -1;
      savedDraft.current = '';

      onSubmit(msg);
      clearPaste();
      setValue('');
    },
    [value, onSubmit, clearPaste],
  );

  return (
    <Box flexDirection="column">
      {pastedLabel && (
        <Text color="cyanBright">
          {pastedLabel}
          <Text dimColor> · Backspace to clear · Enter to send</Text>
        </Text>
      )}
      <LineInput
        value={value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onHistoryPrev={handleHistoryPrev}
        onHistoryNext={handleHistoryNext}
        placeholder={
          pastedLabel ? 'Add a comment or press Enter to send' : (placeholder ?? 'Type your message...')
        }
        maxVisibleLines={5}
      />
    </Box>
  );
}

export const InputBar = React.memo(InputBarComponent);
