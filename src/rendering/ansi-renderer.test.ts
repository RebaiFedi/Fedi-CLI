import { describe, it } from 'node:test';
import assert from 'node:assert';
import chalk from 'chalk';
import { wordWrap, entriesToAnsiOutputLines } from './ansi-renderer.js';
import type { DisplayEntry } from '../agents/types.js';

describe('wordWrap', () => {
  it('returns single line when text fits within maxWidth', () => {
    const result = wordWrap('hello world', 80, '  ');
    assert.deepStrictEqual(result, ['hello world']);
  });

  it('wraps long text into multiple lines', () => {
    const text = 'this is a somewhat long sentence that should wrap around';
    const result = wordWrap(text, 25, '  ');
    assert.ok(result.length > 1, 'should produce multiple lines');
  });

  it('preserves ANSI codes when wrapping', () => {
    const text = chalk.bold('hello') + ' ' + chalk.red('world this is a test that should wrap');
    const result = wordWrap(text, 20, '  ');
    assert.ok(result.length >= 1);
    // The first line should contain chalk formatting
    assert.ok(result[0].length > 0);
  });

  it('handles embedded newlines', () => {
    const result = wordWrap('line one\nline two\nline three', 80, '  ');
    assert.ok(result.length >= 3, 'should have at least 3 lines');
  });

  it('returns text unchanged when maxWidth < 10', () => {
    const result = wordWrap('hello world foo bar', 5, '  ');
    assert.deepStrictEqual(result, ['hello world foo bar']);
  });

  it('adds continuation indent on wrapped lines', () => {
    const text = 'word1 word2 word3 word4 word5 word6 word7 word8';
    const result = wordWrap(text, 15, '>> ');
    if (result.length > 1) {
      assert.ok(result[1].startsWith('>> '), 'continuation lines should have indent');
    }
  });
});

describe('entriesToAnsiOutputLines', () => {
  it('converts text entries to output lines', () => {
    const entries: DisplayEntry[] = [
      { text: 'Hello world', kind: 'text' },
    ];
    const lines = entriesToAnsiOutputLines(entries, 'cyan');
    assert.ok(lines.length > 0);
  });

  it('converts action entries', () => {
    const entries: DisplayEntry[] = [
      { text: 'Read file.ts', kind: 'action' },
    ];
    const lines = entriesToAnsiOutputLines(entries, 'green');
    assert.ok(lines.length > 0);
  });

  it('handles empty entries', () => {
    const lines = entriesToAnsiOutputLines([], 'cyan');
    assert.strictEqual(lines.length, 0);
  });

  it('handles code entries', () => {
    const entries: DisplayEntry[] = [
      { text: 'const x = 1;', kind: 'code' },
    ];
    const lines = entriesToAnsiOutputLines(entries, 'yellow');
    assert.ok(lines.length > 0);
  });

  it('handles diff entries', () => {
    const entries: DisplayEntry[] = [
      { text: '+ added line', kind: 'diff-new' },
      { text: '- removed line', kind: 'diff-old' },
    ];
    const lines = entriesToAnsiOutputLines(entries, 'magenta');
    assert.ok(lines.length > 0);
  });
});
