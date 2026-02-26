import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useStdin, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface InputBarProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
}

const PASTE_MIN_LINES = 3;
const MAX_HISTORY = 50;

export function InputBar({ onSubmit, placeholder }: InputBarProps) {
  const [value, setValue] = useState('');
  const [pastedLabel, setPastedLabel] = useState<string | null>(null);
  const fullText = useRef<string>('');
  const pasteCounter = useRef(0);
  const { stdin } = useStdin();
  const skipNextChange = useRef(false);
  const prevValue = useRef('');

  // ── Input history (arrow up/down) ──────────────────────────────────────
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');

  // Detect paste via raw stdin
  useEffect(() => {
    if (!stdin) return;

    const onData = (data: Buffer) => {
      const str = data.toString();
      const lines = str.split('\n').length - 1;
      if (lines >= PASTE_MIN_LINES) {
        skipNextChange.current = true;
        pasteCounter.current++;
        fullText.current = str;
        const lineCount = lines || 1;
        setPastedLabel(`[Pasted text #${pasteCounter.current} +${lineCount} lines]`);
        setValue('');
        prevValue.current = '';
      }
    };

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin]);

  const clearPaste = useCallback(() => {
    setPastedLabel(null);
    fullText.current = '';
    setValue('');
    prevValue.current = '';
  }, []);

  const handleChange = useCallback(
    (text: string) => {
      if (skipNextChange.current) {
        skipNextChange.current = false;
        prevValue.current = '';
        return;
      }

      // Detect backspace when value is empty → clear paste
      if (pastedLabel && text.length === 0 && prevValue.current.length === 0) {
        clearPaste();
        prevValue.current = '';
        return;
      }

      prevValue.current = text;
      setValue(text);
      historyIndex.current = -1;
    },
    [pastedLabel, clearPaste],
  );

  useInput((_input, key) => {
    if (pastedLabel && value === '' && (key.backspace || key.delete)) {
      clearPaste();
    }
    if (pastedLabel && key.escape) {
      clearPaste();
      setValue('');
    }

    // Arrow UP — go back in history
    if (key.upArrow && history.current.length > 0) {
      if (historyIndex.current === -1) {
        savedDraft.current = value;
        historyIndex.current = history.current.length - 1;
      } else if (historyIndex.current > 0) {
        historyIndex.current--;
      }
      const histVal = history.current[historyIndex.current];
      setValue(histVal);
      prevValue.current = histVal;
    }

    // Arrow DOWN — go forward in history / back to draft
    if (key.downArrow && historyIndex.current !== -1) {
      if (historyIndex.current < history.current.length - 1) {
        historyIndex.current++;
        const histVal = history.current[historyIndex.current];
        setValue(histVal);
        prevValue.current = histVal;
      } else {
        historyIndex.current = -1;
        setValue(savedDraft.current);
        prevValue.current = savedDraft.current;
      }
    }
  });

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
    },
    [value, onSubmit, clearPaste],
  );

  return (
    <Box>
      {pastedLabel && <Text color="cyanBright">{pastedLabel} </Text>}
      <TextInput
        value={value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        placeholder={
          pastedLabel ? 'Backspace to clear paste' : (placeholder ?? 'Type your message...')
        }
      />
    </Box>
  );
}
