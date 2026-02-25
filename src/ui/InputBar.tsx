import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useStdin, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface InputBarProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
}

const PASTE_MIN_LINES = 3; // Only treat as paste if 3+ newlines
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
  const historyIndex = useRef(-1);      // -1 = not browsing history
  const savedDraft = useRef('');         // saves current input when browsing

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
    return () => { stdin.off('data', onData); };
  }, [stdin]);

  // Handle backspace/delete when value is empty and paste exists → clear paste
  const handleChange = (text: string) => {
    if (skipNextChange.current) {
      skipNextChange.current = false;
      prevValue.current = '';
      return;
    }

    // Detect backspace: new text is shorter than previous
    if (pastedLabel && text.length < prevValue.current.length && prevValue.current.length === 0) {
      // Value was already empty and user pressed backspace → clear paste
      clearPaste();
      prevValue.current = '';
      return;
    }

    prevValue.current = text;
    setValue(text);
    // Reset history browsing when user types
    historyIndex.current = -1;
  };

  // Catch arrow up/down + backspace/escape via useInput
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
        // Save current draft before browsing
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
        // Back to saved draft
        historyIndex.current = -1;
        setValue(savedDraft.current);
        prevValue.current = savedDraft.current;
      }
    }
  });

  const clearPaste = () => {
    setPastedLabel(null);
    fullText.current = '';
    setValue('');
    prevValue.current = '';
  };

  const handleSubmit = (text: string) => {
    const extra = value.trim();
    const pasted = fullText.current.trim();
    const toSend = pasted ? (extra ? `${pasted}\n\n${extra}` : pasted) : text;
    if (!toSend.trim()) return;

    // Add to history
    const msg = toSend.trim();
    if (msg && (history.current.length === 0 || history.current[history.current.length - 1] !== msg)) {
      history.current.push(msg);
      if (history.current.length > MAX_HISTORY) {
        history.current.shift();
      }
    }
    historyIndex.current = -1;
    savedDraft.current = '';

    onSubmit(msg);
    clearPaste();
  };

  return (
    <Box>
      {pastedLabel && <Text color="cyanBright">{pastedLabel} </Text>}
      <TextInput
        value={value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        placeholder={pastedLabel ? 'Backspace to clear paste' : (placeholder ?? 'Type your message...')}
      />
    </Box>
  );
}
