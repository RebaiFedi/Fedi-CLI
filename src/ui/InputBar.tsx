import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useStdin, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface InputBarProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
}

const PASTE_MIN_LINES = 3; // Only treat as paste if 3+ newlines

export function InputBar({ onSubmit, placeholder }: InputBarProps) {
  const [value, setValue] = useState('');
  const [pastedLabel, setPastedLabel] = useState<string | null>(null);
  const fullText = useRef<string>('');
  const pasteCounter = useRef(0);
  const { stdin } = useStdin();
  const skipNextChange = useRef(false);
  const prevValue = useRef('');

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
  };

  // Also catch backspace/escape via useInput for reliability
  useInput((input, key) => {
    if (pastedLabel && value === '' && (key.backspace || key.delete)) {
      clearPaste();
    }
    if (pastedLabel && key.escape) {
      clearPaste();
      setValue('');
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
    onSubmit(toSend.trim());
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
