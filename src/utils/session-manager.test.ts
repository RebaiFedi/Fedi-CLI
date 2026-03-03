import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionManager, buildResumePrompt, RESUME_CONTEXT_MESSAGES } from './session-manager.js';
import type { Message, SessionData } from '../agents/types.js';

function msg(from: Message['from'], to: Message['to'], content: string): Message {
  return { id: randomUUID(), from, to, content, relayCount: 0, timestamp: Date.now() };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `fedi-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('creates a session', async () => {
    const sm = new SessionManager(tempDir);
    const session = await sm.createSession('test task', tempDir);
    assert.ok(session.id);
    assert.strictEqual(session.task, 'test task');
    assert.strictEqual(session.version, 2);
    assert.ok(session.startedAt > 0);
    assert.deepStrictEqual(session.messages, []);
  });

  it('adds messages to session', async () => {
    const sm = new SessionManager(tempDir);
    await sm.createSession('test task', tempDir);
    sm.addMessage(msg('user', 'opus', 'hello'));
    const session = sm.getSession();
    assert.ok(session);
    assert.strictEqual(session.messages.length, 1);
    assert.strictEqual(session.messages[0].content, 'hello');
  });

  it('truncates messages at 1000', async () => {
    const sm = new SessionManager(tempDir);
    await sm.createSession('test task', tempDir);
    for (let i = 0; i < 1005; i++) {
      sm.addMessage(msg('user', 'opus', `msg ${i}`));
    }
    const session = sm.getSession();
    assert.ok(session);
    assert.ok(session.messages.length <= 1000);
  });

  it('sets agent session ID', async () => {
    const sm = new SessionManager(tempDir);
    await sm.createSession('test task', tempDir);
    sm.setAgentSession('opus', 'session-123');
    const session = sm.getSession();
    assert.ok(session);
    assert.strictEqual(session.agentSessions.opus, 'session-123');
  });

  it('finalizes session', async () => {
    const sm = new SessionManager(tempDir);
    await sm.createSession('test task', tempDir);
    sm.addMessage(msg('user', 'opus', 'hello'));
    await sm.finalize();
    const session = sm.getSession();
    assert.ok(session);
    assert.ok(session.finishedAt);
    assert.ok(session.finishedAt >= session.startedAt);
  });

  it('saves and loads session', async () => {
    const sm = new SessionManager(tempDir);
    const created = await sm.createSession('test task', tempDir);
    sm.addMessage(msg('user', 'opus', 'hello'));
    await sm.finalize();

    const sm2 = new SessionManager(tempDir);
    const loaded = await sm2.loadSession(created.id);
    assert.ok(loaded);
    assert.strictEqual(loaded.id, created.id);
    assert.strictEqual(loaded.task, 'test task');
    assert.strictEqual(loaded.messages.length, 1);
  });

  it('lists sessions', async () => {
    const sm = new SessionManager(tempDir);
    await sm.createSession('task 1', tempDir);
    await sm.finalize();

    const sm2 = new SessionManager(tempDir);
    await sm2.createSession('task 2', tempDir);
    await sm2.finalize();

    const sm3 = new SessionManager(tempDir);
    const sessions = await sm3.listSessions();
    assert.strictEqual(sessions.length, 2);
    // Sorted by startedAt descending
    assert.ok(sessions[0].startedAt >= sessions[1].startedAt);
  });

  it('returns empty list when no sessions directory', async () => {
    const sm = new SessionManager(join(tempDir, 'nonexistent'));
    const sessions = await sm.listSessions();
    assert.deepStrictEqual(sessions, []);
  });

  it('returns null for non-existent session', async () => {
    const sm = new SessionManager(tempDir);
    const loaded = await sm.loadSession('nonexistent-id');
    assert.strictEqual(loaded, null);
  });

  it('finalize is idempotent', async () => {
    const sm = new SessionManager(tempDir);
    await sm.createSession('test task', tempDir);
    await sm.finalize();
    const session1 = sm.getSession();
    const finishedAt1 = session1?.finishedAt;
    await sm.finalize();
    const session2 = sm.getSession();
    assert.strictEqual(session2?.finishedAt, finishedAt1);
  });

  it('addMessage is noop when no session', () => {
    const sm = new SessionManager(tempDir);
    // Should not throw
    sm.addMessage(msg('user', 'opus', 'hello'));
    assert.strictEqual(sm.getSession(), null);
  });
});

describe('buildResumePrompt', () => {
  it('builds resume prompt from session', () => {
    const session: SessionData = {
      id: 'test-id',
      version: 2,
      task: 'fix the bug',
      projectDir: '/tmp',
      startedAt: Date.now() - 10000,
      messages: [
        msg('user', 'opus', 'fix the login page'),
        msg('opus', 'sonnet', 'analyse le composant Login'),
      ],
      agentSessions: {},
    };
    const prompt = buildResumePrompt(session);
    assert.ok(prompt.includes('fix the bug'));
    assert.ok(prompt.includes('fix the login page'));
    assert.ok(prompt.includes('SESSION REPRISE'));
  });

  it('truncates long messages', () => {
    const longContent = 'x'.repeat(200);
    const session: SessionData = {
      id: 'test-id',
      version: 2,
      task: 'task',
      projectDir: '/tmp',
      startedAt: Date.now(),
      messages: [msg('user', 'opus', longContent)],
      agentSessions: {},
    };
    const prompt = buildResumePrompt(session);
    assert.ok(prompt.includes('...'), 'long messages should be truncated');
  });

  it('limits context to RESUME_CONTEXT_MESSAGES', () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      msg('user', 'opus', `message ${i}`),
    );
    const session: SessionData = {
      id: 'test-id',
      version: 2,
      task: 'task',
      projectDir: '/tmp',
      startedAt: Date.now(),
      messages,
      agentSessions: {},
    };
    const prompt = buildResumePrompt(session);
    // Should only contain the last RESUME_CONTEXT_MESSAGES messages
    assert.ok(prompt.includes(`message ${30 - 1}`));
    assert.ok(!prompt.includes(`message 0\n`));
    // Verify constant exists
    assert.strictEqual(typeof RESUME_CONTEXT_MESSAGES, 'number');
  });
});
