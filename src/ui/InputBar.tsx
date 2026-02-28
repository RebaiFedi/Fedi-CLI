import React, { useState, useRef, useEffect, useCallback } from 'react';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Box } from 'ink';
import { LineInput } from './LineInput.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  projectDir?: string;
}

const MAX_HISTORY = 50;
const HISTORY_FILE_NAME = 'input-history.json';

function InputBarComponent({ onSubmit, placeholder, projectDir }: InputBarProps) {
  const [value, setValue] = useState('');
  const [pastedText, setPastedText] = useState<string | null>(null);
  const pasteCounter = useRef(0);

  // ── Input history ──────────────────────────────────────────────────────────
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');
  const historyFilePath = React.useMemo(
    () => join(projectDir ?? process.cwd(), 'sessions', HISTORY_FILE_NAME),
    [projectDir],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await fs.readFile(historyFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const arr =
          Array.isArray(parsed) ? parsed :
          parsed && typeof parsed === 'object' && Array.isArray((parsed as { history?: unknown }).history)
            ? (parsed as { history: unknown[] }).history
            : [];
        const loaded = arr
          .filter((v): v is string => typeof v === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(-MAX_HISTORY);
        if (!cancelled) {
          history.current = loaded;
        }
      } catch {
        // No persisted history yet — ignore.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historyFilePath]);

  const persistHistory = useCallback(
    (items: string[]) => {
      const payload = JSON.stringify({ version: 1, history: items.slice(-MAX_HISTORY) }, null, 2);
      void (async () => {
        try {
          await fs.mkdir(dirname(historyFilePath), { recursive: true });
          await fs.writeFile(historyFilePath, payload, 'utf-8');
        } catch {
          // History persistence failure should never break input UX.
        }
      })();
    },
    [historyFilePath],
  );

  const clearPaste = useCallback(() => {
    setPastedText(null);
  }, []);

  const handleClear = useCallback(() => {
    clearPaste();
    setValue('');
    historyIndex.current = -1;
    savedDraft.current = '';
  }, [clearPaste]);

  // ── Paste callback from LineInput ─────────────────────────────────────────
  const handlePaste = useCallback((text: string) => {
    pasteCounter.current++;
    setPastedText((prev) => prev ? prev + text : text);
  }, []);

  // ── Build paste badge ─────────────────────────────────────────────────────
  const pasteBadge = React.useMemo(() => {
    if (!pastedText) return undefined;
    const lineCount = pastedText.split('\n').length;
    return `[Pasted text #${pasteCounter.current} +${lineCount} lines]`;
  }, [pastedText]);

  // ── History navigation ────────────────────────────────────────────────────
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

  const handleTab = useCallback(() => {
    // Reserved for future command autocompletion.
  }, []);

  // ── Change handler ────────────────────────────────────────────────────────
  const handleChange = useCallback(
    (text: string) => {
      // Backspace on empty with paste active = clear paste
      if (pastedText && text.length === 0 && value.length === 0) {
        clearPaste();
        return;
      }

      setValue(text);
      historyIndex.current = -1;
    },
    [pastedText, clearPaste, value],
  );

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    (text: string) => {
      const comment = text.trim();

      if (pastedText) {
        // Strip only leading/trailing empty lines, preserve internal indentation
        const pastedLines = pastedText.split('\n');
        while (pastedLines.length > 0 && pastedLines[0]!.trim() === '') pastedLines.shift();
        while (pastedLines.length > 0 && pastedLines[pastedLines.length - 1]!.trim() === '') pastedLines.pop();
        const cleanPaste = pastedLines.join('\n');

        if (!cleanPaste && !comment) return;

        // Build final message: comment first (as instruction), then pasted content verbatim
        let msg: string;
        if (comment && cleanPaste) {
          msg = `${comment}\n\n${cleanPaste}`;
        } else {
          msg = cleanPaste || comment;
        }

        if (
          history.current.length === 0 || history.current[history.current.length - 1] !== msg
        ) {
          const nextHistory = [...history.current, msg].slice(-MAX_HISTORY);
          history.current = nextHistory;
          persistHistory(nextHistory);
        }
        historyIndex.current = -1;
        savedDraft.current = '';

        onSubmit(msg);
        clearPaste();
        setValue('');
        return;
      }

      // No paste — normal submit
      const msg = text.trim();
      if (!msg) return;

      if (
        history.current.length === 0 || history.current[history.current.length - 1] !== msg
      ) {
        const nextHistory = [...history.current, msg].slice(-MAX_HISTORY);
        history.current = nextHistory;
        persistHistory(nextHistory);
      }
      historyIndex.current = -1;
      savedDraft.current = '';

      onSubmit(msg);
      setValue('');
    },
    [pastedText, onSubmit, clearPaste, persistHistory],
  );

  return (
    <Box flexDirection="column">
      <LineInput
        value={value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onPaste={handlePaste}
        onHistoryPrev={handleHistoryPrev}
        onHistoryNext={handleHistoryNext}
        onTab={handleTab}
        onClear={handleClear}
        placeholder={placeholder ?? 'Type your message...'}
        prefixBadge={pasteBadge}
        maxVisibleLines={8}
      />
    </Box>
  );
}

export const InputBar = React.memo(InputBarComponent);
