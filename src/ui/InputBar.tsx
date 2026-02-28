import React, { useState, useRef, useEffect, useCallback } from 'react';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Box, Text, useStdin } from 'ink';
import { LineInput } from './LineInput.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  projectDir?: string;
}

// A paste is detected when a chunk arrives on stdin that:
//  - Has >= PASTE_MIN_LINES newlines, OR
//  - Has >= PASTE_MIN_CHARS chars AND arrives within PASTE_TIMING_MS of the previous chunk
const PASTE_MIN_LINES = 3;
const PASTE_MIN_CHARS = 40;
const PASTE_TIMING_MS = 20; // chars arriving faster than this = paste burst
const MAX_HISTORY = 50;
const HISTORY_FILE_NAME = 'input-history.json';

function InputBarComponent({ onSubmit, placeholder, projectDir }: InputBarProps) {
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
        // No persisted history yet (or unreadable file) — ignore silently.
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
    setPastedLabel(null);
    fullText.current = '';
    isProcessingPaste.current = false;
    setValue('');
  }, []);

  const handleClear = useCallback(() => {
    clearPaste();
    setValue('');
    historyIndex.current = -1;
    savedDraft.current = '';
  }, [clearPaste]);

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
        // Auto-reset after 100ms so normal keystrokes aren't blocked after paste
        setTimeout(() => { isProcessingPaste.current = false; }, 100);
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

  const handleTab = useCallback(() => {
    // Hook reserved for future command autocompletion.
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
        const nextHistory = [...history.current, msg].slice(-MAX_HISTORY);
        history.current = nextHistory;
        persistHistory(nextHistory);
      }
      historyIndex.current = -1;
      savedDraft.current = '';

      onSubmit(msg);
      clearPaste();
      setValue('');
    },
    [value, onSubmit, clearPaste, persistHistory],
  );

  // ── Paste preview: first 5 lines of pasted content ───────────────────────
  const pastePreviewLines = React.useMemo(() => {
    if (!pastedLabel || !fullText.current) return null;
    const lines = fullText.current.split('\n');
    const preview = lines.slice(0, 5);
    const hasMore = lines.length > 5;
    return { preview, hasMore, total: lines.length };
  }, [pastedLabel]);

  return (
    <Box flexDirection="column">
      {pastedLabel && (
        <Box flexDirection="column">
          <Text color="cyanBright">
            {pastedLabel}
            <Text dimColor> · Backspace to clear · Enter to send</Text>
          </Text>
          {pastePreviewLines && pastePreviewLines.preview.map((line: string, i: number) => (
            <Text key={i} dimColor>{'  '}{line}</Text>
          ))}
          {pastePreviewLines && pastePreviewLines.hasMore && (
            <Text dimColor>{'  '}... ({pastePreviewLines.total - 5} more lines)</Text>
          )}
        </Box>
      )}
      <LineInput
        value={value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onHistoryPrev={handleHistoryPrev}
        onHistoryNext={handleHistoryNext}
        onTab={handleTab}
        onClear={handleClear}
        placeholder={
          pastedLabel ? 'Add a comment or press Enter to send' : (placeholder ?? 'Type your message...')
        }
        maxVisibleLines={5}
      />
    </Box>
  );
}

export const InputBar = React.memo(InputBarComponent);
