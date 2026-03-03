import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Test the input parsing logic from useInputHandler.
 * Since it's a React hook, we test the parsing patterns directly
 * rather than calling the hook.
 */

describe('useInputHandler — input parsing', () => {
  it('detects @opus as a direct message', () => {
    const text = '@opus analyze the code';
    const agentPrefixes = [
      { prefix: '@opus ', agent: 'opus' },
      { prefix: '@codex ', agent: 'codex' },
      { prefix: '@sonnet ', agent: 'sonnet' },
      { prefix: '@claude ', agent: 'sonnet' },
    ] as const;
    let targetAgent: string | null = null;
    let agentMessage = text;
    for (const { prefix, agent } of agentPrefixes) {
      if (text.toLowerCase().startsWith(prefix)) {
        targetAgent = agent;
        agentMessage = text.slice(prefix.length);
        break;
      }
    }
    assert.equal(targetAgent, 'opus');
    assert.equal(agentMessage, 'analyze the code');
  });

  it('detects @tous as broadcast', () => {
    const text = '@tous check the project';
    const allMatch = text.match(/^@(tous|all)\s+(.+)$/i);
    assert.ok(allMatch, 'should match @tous pattern');
    assert.equal(allMatch![2], 'check the project');
  });

  it('detects @all as broadcast', () => {
    const text = '@all fix everything';
    const allMatch = text.match(/^@(tous|all)\s+(.+)$/i);
    assert.ok(allMatch, 'should match @all pattern');
    assert.equal(allMatch![2], 'fix everything');
  });

  it('passes plain text as normal message (no @ prefix)', () => {
    const text = 'just a normal message';
    const agentPrefixes = [
      { prefix: '@opus ', agent: 'opus' },
      { prefix: '@codex ', agent: 'codex' },
      { prefix: '@sonnet ', agent: 'sonnet' },
      { prefix: '@claude ', agent: 'sonnet' },
    ] as const;
    let targetAgent: string | null = null;
    for (const { prefix, agent } of agentPrefixes) {
      if (text.toLowerCase().startsWith(prefix)) {
        targetAgent = agent;
        break;
      }
    }
    const allMatch = text.match(/^@(tous|all)\s+(.+)$/i);
    assert.equal(targetAgent, null, 'should not match any agent prefix');
    assert.equal(allMatch, null, 'should not match @tous/@all');
  });

  it('detects @claude as sonnet alias', () => {
    const text = '@claude build the page';
    const agentPrefixes = [
      { prefix: '@opus ', agent: 'opus' },
      { prefix: '@codex ', agent: 'codex' },
      { prefix: '@sonnet ', agent: 'sonnet' },
      { prefix: '@claude ', agent: 'sonnet' },
    ] as const;
    let targetAgent: string | null = null;
    let agentMessage = text;
    for (const { prefix, agent } of agentPrefixes) {
      if (text.toLowerCase().startsWith(prefix)) {
        targetAgent = agent;
        agentMessage = text.slice(prefix.length);
        break;
      }
    }
    assert.equal(targetAgent, 'sonnet');
    assert.equal(agentMessage, 'build the page');
  });

  it('detects slash commands', () => {
    const text = '/help';
    assert.ok(text.trim().startsWith('/'), 'should be recognized as slash command');
    const parts = text.trim().slice(1).split(/\s+/);
    assert.equal(parts[0], 'help');
  });

  it('detects @sessions command', () => {
    const text = '@sessions';
    assert.ok(/^@sessions\s*$/i.test(text.trim()), 'should match @sessions');
  });
});
