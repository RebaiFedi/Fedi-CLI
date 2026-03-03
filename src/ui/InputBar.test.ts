import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the InputBar's core logic: submit handling, history management,
 * paste detection, and input parsing.
 *
 * These test the pure logic extracted from the React component to avoid
 * needing an Ink renderer.
 */

const MAX_HISTORY = 50;

// ── Submit logic (from InputBar.handleSubmit) ──

function simulateSubmit(
  text: string,
  pastedText: string | null,
  history: string[],
): { submitted: string | null; newHistory: string[] } {
  const comment = text.trim();

  if (pastedText) {
    const pastedLines = pastedText.split('\n');
    while (pastedLines.length > 0 && pastedLines[0]!.trim() === '') pastedLines.shift();
    while (pastedLines.length > 0 && pastedLines[pastedLines.length - 1]!.trim() === '')
      pastedLines.pop();
    const cleanPaste = pastedLines.join('\n');

    if (!cleanPaste && !comment) return { submitted: null, newHistory: history };

    let msg: string;
    if (comment && cleanPaste) {
      msg = `${comment}\n\n${cleanPaste}`;
    } else {
      msg = cleanPaste || comment;
    }

    const nextHistory =
      history.length === 0 || history[history.length - 1] !== msg
        ? [...history, msg].slice(-MAX_HISTORY)
        : history;
    return { submitted: msg, newHistory: nextHistory };
  }

  const msg = text.trim();
  if (!msg) return { submitted: null, newHistory: history };

  const nextHistory =
    history.length === 0 || history[history.length - 1] !== msg
      ? [...history, msg].slice(-MAX_HISTORY)
      : history;
  return { submitted: msg, newHistory: nextHistory };
}

// ── History navigation logic ──

function simulateHistoryPrev(
  history: string[],
  currentIndex: number,
  currentValue: string,
): { newIndex: number; newValue: string; savedDraft: string } {
  if (history.length === 0) return { newIndex: currentIndex, newValue: currentValue, savedDraft: '' };
  if (currentIndex === -1) {
    return {
      newIndex: history.length - 1,
      newValue: history[history.length - 1] ?? '',
      savedDraft: currentValue,
    };
  }
  if (currentIndex > 0) {
    return {
      newIndex: currentIndex - 1,
      newValue: history[currentIndex - 1] ?? '',
      savedDraft: '',
    };
  }
  return { newIndex: currentIndex, newValue: history[currentIndex] ?? '', savedDraft: '' };
}

function simulateHistoryNext(
  history: string[],
  currentIndex: number,
  savedDraft: string,
): { newIndex: number; newValue: string } {
  if (currentIndex === -1) return { newIndex: -1, newValue: '' };
  if (currentIndex < history.length - 1) {
    return { newIndex: currentIndex + 1, newValue: history[currentIndex + 1] ?? '' };
  }
  return { newIndex: -1, newValue: savedDraft };
}

// ── Paste detection logic (from LineInput) ──

function detectPaste(input: string): boolean {
  const newlineCount = (input.match(/\n/g) ?? []).length;
  return newlineCount >= 3 || input.length >= 40;
}

// ── Cursor/editing logic (from LineInput) ──

function applyBackspace(value: string, offset: number): { value: string; offset: number } {
  if (offset <= 0) return { value, offset: 0 };
  return {
    value: value.slice(0, offset - 1) + value.slice(offset),
    offset: offset - 1,
  };
}

function applyInsert(
  value: string,
  offset: number,
  input: string,
): { value: string; offset: number } {
  return {
    value: value.slice(0, offset) + input + value.slice(offset),
    offset: offset + input.length,
  };
}

function applyDeleteToEnd(value: string, offset: number): { value: string; offset: number } {
  return { value: value.slice(0, offset), offset };
}

function applyDeleteToStart(value: string, offset: number): { value: string; offset: number } {
  return { value: value.slice(offset), offset: 0 };
}

function wordLeftOffset(value: string, offset: number): number {
  let i = offset;
  while (i > 0 && /\s/.test(value[i - 1] ?? '')) i--;
  while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--;
  return i;
}

function wordRightOffset(value: string, offset: number): number {
  let i = offset;
  while (i < value.length && /\s/.test(value[i] ?? '')) i++;
  while (i < value.length && !/\s/.test(value[i] ?? '')) i++;
  return i;
}

// ── Tests ──

describe('InputBar — submit logic', () => {
  it('trims whitespace on submit', () => {
    const result = simulateSubmit('  hello world  ', null, []);
    assert.equal(result.submitted, 'hello world');
  });

  it('rejects empty messages', () => {
    const result = simulateSubmit('   ', null, []);
    assert.equal(result.submitted, null);
  });

  it('adds message to history', () => {
    const result = simulateSubmit('hello', null, []);
    assert.deepEqual(result.newHistory, ['hello']);
  });

  it('does not duplicate last history entry', () => {
    const result = simulateSubmit('hello', null, ['hello']);
    assert.deepEqual(result.newHistory, ['hello']);
  });

  it('limits history to MAX_HISTORY entries', () => {
    const bigHistory = Array.from({ length: 55 }, (_, i) => `msg${i}`);
    const result = simulateSubmit('new', null, bigHistory);
    assert.equal(result.newHistory.length, MAX_HISTORY);
    assert.equal(result.newHistory[result.newHistory.length - 1], 'new');
  });

  it('handles pasted text with comment', () => {
    const result = simulateSubmit('my comment', 'line1\nline2\nline3', []);
    assert.equal(result.submitted, 'my comment\n\nline1\nline2\nline3');
  });

  it('handles pasted text without comment', () => {
    const result = simulateSubmit('', 'line1\nline2', []);
    assert.equal(result.submitted, 'line1\nline2');
  });

  it('strips leading/trailing empty lines from paste', () => {
    const result = simulateSubmit('', '\n\n  hello  \n\n', []);
    assert.equal(result.submitted, '  hello  ');
  });

  it('rejects empty paste with no comment', () => {
    const result = simulateSubmit('', '\n\n\n', []);
    assert.equal(result.submitted, null);
  });
});

describe('InputBar — history navigation', () => {
  it('navigates to last history item on first prev', () => {
    const result = simulateHistoryPrev(['a', 'b', 'c'], -1, 'draft');
    assert.equal(result.newIndex, 2);
    assert.equal(result.newValue, 'c');
    assert.equal(result.savedDraft, 'draft');
  });

  it('navigates backward through history', () => {
    const result = simulateHistoryPrev(['a', 'b', 'c'], 2, '');
    assert.equal(result.newIndex, 1);
    assert.equal(result.newValue, 'b');
  });

  it('stays at first item when at beginning', () => {
    const result = simulateHistoryPrev(['a', 'b'], 0, '');
    assert.equal(result.newIndex, 0);
    assert.equal(result.newValue, 'a');
  });

  it('does nothing when history is empty', () => {
    const result = simulateHistoryPrev([], -1, 'draft');
    assert.equal(result.newIndex, -1);
    assert.equal(result.newValue, 'draft');
  });

  it('navigates forward through history', () => {
    const result = simulateHistoryNext(['a', 'b', 'c'], 0, '');
    assert.equal(result.newIndex, 1);
    assert.equal(result.newValue, 'b');
  });

  it('restores draft when moving past last item', () => {
    const result = simulateHistoryNext(['a', 'b'], 1, 'my draft');
    assert.equal(result.newIndex, -1);
    assert.equal(result.newValue, 'my draft');
  });

  it('does nothing when not in history (index -1)', () => {
    const result = simulateHistoryNext(['a', 'b'], -1, '');
    assert.equal(result.newIndex, -1);
  });
});

describe('InputBar — paste detection', () => {
  it('detects multiline paste (>= 3 newlines)', () => {
    assert.equal(detectPaste('a\nb\nc\nd'), true);
  });

  it('detects long paste (>= 40 chars)', () => {
    assert.equal(detectPaste('a'.repeat(40)), true);
  });

  it('does not detect short single-line input', () => {
    assert.equal(detectPaste('hello world'), false);
  });

  it('does not detect input with 2 newlines', () => {
    assert.equal(detectPaste('a\nb\nc'), false);
  });
});

describe('InputBar — cursor/editing operations', () => {
  it('backspace removes character before cursor', () => {
    const result = applyBackspace('hello', 5);
    assert.equal(result.value, 'hell');
    assert.equal(result.offset, 4);
  });

  it('backspace in middle of text', () => {
    const result = applyBackspace('hello', 3);
    assert.equal(result.value, 'helo');
    assert.equal(result.offset, 2);
  });

  it('backspace at position 0 does nothing', () => {
    const result = applyBackspace('hello', 0);
    assert.equal(result.value, 'hello');
    assert.equal(result.offset, 0);
  });

  it('insert text at cursor position', () => {
    const result = applyInsert('helo', 3, 'l');
    assert.equal(result.value, 'hello');
    assert.equal(result.offset, 4);
  });

  it('insert at beginning', () => {
    const result = applyInsert('ello', 0, 'h');
    assert.equal(result.value, 'hello');
    assert.equal(result.offset, 1);
  });

  it('Ctrl+K deletes to end of line', () => {
    const result = applyDeleteToEnd('hello world', 5);
    assert.equal(result.value, 'hello');
    assert.equal(result.offset, 5);
  });

  it('Ctrl+U deletes to start of line', () => {
    const result = applyDeleteToStart('hello world', 5);
    assert.equal(result.value, ' world');
    assert.equal(result.offset, 0);
  });

  it('word-left jumps to previous word boundary', () => {
    assert.equal(wordLeftOffset('hello world foo', 15), 12);
    assert.equal(wordLeftOffset('hello world foo', 12), 6);
    assert.equal(wordLeftOffset('hello world foo', 6), 0);
  });

  it('word-right jumps to next word boundary', () => {
    assert.equal(wordRightOffset('hello world foo', 0), 5);
    assert.equal(wordRightOffset('hello world foo', 5), 11);
    assert.equal(wordRightOffset('hello world foo', 11), 15);
  });

  it('word-left at position 0 stays at 0', () => {
    assert.equal(wordLeftOffset('hello', 0), 0);
  });

  it('word-right at end stays at end', () => {
    assert.equal(wordRightOffset('hello', 5), 5);
  });
});
