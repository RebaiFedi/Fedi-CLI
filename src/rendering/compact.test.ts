import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compact, addActionSpacing, compactOutputLines } from './compact.js';
import type { DisplayEntry } from '../agents/types.js';

// ── Helper ──────────────────────────────────────────────────────────────────

function e(kind: DisplayEntry['kind'], text = ''): DisplayEntry {
  return { text, kind };
}

// ── compact() ───────────────────────────────────────────────────────────────

describe('compact', () => {
  it('removes consecutive empty entries', () => {
    const input = [e('text', 'hello'), e('empty'), e('empty'), e('text', 'world')];
    const result = compact(input);
    assert.equal(result.length, 3);
    assert.equal(result[1].kind, 'empty');
  });

  it('removes leading empty entries', () => {
    const input = [e('empty'), e('empty'), e('text', 'hello')];
    const result = compact(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'hello');
  });

  it('preserves single empty between text', () => {
    const input = [e('text', 'a'), e('empty'), e('text', 'b')];
    const result = compact(input);
    assert.equal(result.length, 3);
  });

  it('returns empty array for empty input', () => {
    assert.equal(compact([]).length, 0);
  });
});

// ── addActionSpacing() ──────────────────────────────────────────────────────

describe('addActionSpacing', () => {
  it('adds spacing after action block before text', () => {
    const input = [e('action', 'Read foo'), e('text', 'content')];
    const result = addActionSpacing(input);
    assert.ok(result.some((r) => r.kind === 'empty'));
    assert.ok(result.length > input.length);
  });

  it('adds spacing before action block after text', () => {
    const input = [e('text', 'content'), e('action', 'Read foo')];
    const result = addActionSpacing(input);
    assert.ok(result.some((r) => r.kind === 'empty'));
  });

  it('adds spacing before headings', () => {
    const input = [e('text', 'paragraph'), e('heading', 'Title')];
    const result = addActionSpacing(input);
    assert.ok(result.some((r) => r.kind === 'empty'));
  });

  it('does not add spacing between consecutive actions', () => {
    const input = [e('action', 'Read foo'), e('action', 'Read bar')];
    const result = addActionSpacing(input);
    assert.ok(!result.some((r, i) => r.kind === 'empty' && i > 0 && i < result.length - 1));
  });

  it('adds spacing between tool-header blocks', () => {
    const input = [
      e('tool-header', 'Edit foo'),
      e('diff-old', 'old'),
      e('diff-new', 'new'),
      e('tool-header', 'Edit bar'),
    ];
    const result = addActionSpacing(input);
    assert.ok(result.filter((r) => r.kind === 'empty').length >= 1);
  });
});

// ── compactOutputLines() ────────────────────────────────────────────────────

describe('compactOutputLines', () => {
  it('collapses consecutive empty lines', () => {
    const input = ['hello', '', '', '', 'world'];
    const result = compactOutputLines(input);
    assert.equal(result.length, 3); // hello, '', world
  });

  it('preserves single empty line between text', () => {
    const input = ['hello', '', 'world'];
    const result = compactOutputLines(input);
    assert.equal(result.length, 3);
  });

  it('handles ANSI codes in empty lines', () => {
    const input = ['hello', '\x1b[31m\x1b[0m', '', 'world'];
    const result = compactOutputLines(input);
    // Both "\x1b[31m\x1b[0m" and "" are empty after stripping — collapse
    assert.ok(result.length <= 3);
  });

  it('returns empty array for empty input', () => {
    assert.equal(compactOutputLines([]).length, 0);
  });
});
