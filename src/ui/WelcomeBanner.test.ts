import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { printWelcomeBanner } from './WelcomeBanner.js';
import stripAnsi from 'strip-ansi';

describe('WelcomeBanner', () => {
  let output: string[];
  const origLog = console.log;

  beforeEach(() => {
    output = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
  });

  afterEach(() => {
    console.log = origLog;
  });

  it('displays the version', () => {
    printWelcomeBanner('/home/user/project');
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Fedi Cli'), 'should show Fedi Cli');
    assert.ok(/v\d+\.\d+\.\d+/.test(text), 'should include version number');
  });

  it('displays the project directory', () => {
    printWelcomeBanner('/home/user/myproject');
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('~/myproject'), 'should show shortened directory');
  });

  it('displays all 3 agent names', () => {
    printWelcomeBanner('/home/user/project');
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Opus'), 'should show Opus');
    assert.ok(text.includes('Sonnet'), 'should show Sonnet');
    assert.ok(text.includes('Codex'), 'should show Codex');
  });
});
