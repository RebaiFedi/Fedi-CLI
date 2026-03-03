import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { printUserBubble } from './UserBubble.js';
import stripAnsi from 'strip-ansi';

describe('UserBubble', () => {
  let output: string[];
  const origLog = console.log;
  const origColumns = process.stdout.columns;

  beforeEach(() => {
    output = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    // Force a known terminal width
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  afterEach(() => {
    console.log = origLog;
    Object.defineProperty(process.stdout, 'columns', {
      value: origColumns,
      configurable: true,
    });
  });

  it('displays user text', () => {
    printUserBubble('Hello world');
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Hello world'), 'should contain the user text');
  });

  it('displays the user prefix marker', () => {
    printUserBubble('Test message');
    const text = stripAnsi(output.join('\n'));
    // The prefix is the ❯ character
    assert.ok(text.includes('\u276F'), 'should show the user prefix marker');
  });

  it('handles empty text without crashing', () => {
    assert.doesNotThrow(() => printUserBubble(''));
    assert.ok(output.length > 0, 'should produce output even for empty text');
  });
});
