import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { printSessionResume } from './SessionResumeView.js';
import type { SessionData } from '../agents/types.js';
import stripAnsi from 'strip-ansi';

function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: 'abc12345-6789-0000-0000-000000000000',
    version: 2,
    task: 'Fix the login bug',
    projectDir: '/tmp/test-project',
    startedAt: Date.now() - 60000,
    messages: [
      { id: 'm1', from: 'user', to: 'opus', content: 'Fix the login bug', relayCount: 0, timestamp: Date.now() - 30000 },
      {
        id: 'm2',
        from: 'opus',
        to: 'all',
        content: 'Working on it...',
        relayCount: 0,
        timestamp: Date.now() - 20000,
      },
    ],
    agentSessions: {},
    ...overrides,
  };
}

describe('SessionResumeView', () => {
  let output: string[];
  const origLog = console.log;

  beforeEach(() => {
    output = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
  });

  afterEach(() => {
    console.log = origLog;
  });

  it('displays the session id', () => {
    printSessionResume(makeSession(), 'abc12345-6789');
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('abc12345'), 'should show short session id');
  });

  it('displays the task', () => {
    printSessionResume(makeSession(), 'abc12345');
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Fix the login bug'), 'should show the task');
  });

  it('displays recent messages', () => {
    printSessionResume(makeSession(), 'abc12345');
    const text = stripAnsi(output.join('\n'));
    assert.ok(text.includes('Working on it'), 'should show message content');
  });
});
