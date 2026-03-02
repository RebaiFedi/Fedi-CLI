import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentId, OutputLine } from '../agents/types.js';
import type { OrchestratorCallbacks } from './orchestrator.js';
import { BufferManager } from './buffer-manager.js';

function makeLine(text: string, type: OutputLine['type'] = 'stdout'): OutputLine {
  return { text, timestamp: Date.now(), type };
}

function makeMockCallbacks(): OrchestratorCallbacks & {
  outputs: Array<{ agent: AgentId; line: OutputLine }>;
} {
  const outputs: Array<{ agent: AgentId; line: OutputLine }> = [];
  return {
    outputs,
    onAgentOutput: (agent, line) => outputs.push({ agent, line }),
    onAgentStatus: () => {},
    onRelay: () => {},
    onRelayBlocked: () => {},
  };
}

describe('BufferManager', () => {
  let bm: BufferManager;

  beforeEach(() => {
    bm = new BufferManager();
  });

  // ── Buffer operations ──

  describe('buffer operations', () => {
    it('starts with empty buffers', () => {
      assert.deepEqual(bm.getBuffer('sonnet'), []);
      assert.deepEqual(bm.getBuffer('codex'), []);
      assert.deepEqual(bm.getBuffer('opus'), []);
    });

    it('pushToBuffer appends lines', () => {
      const line1 = makeLine('line 1');
      const line2 = makeLine('line 2');
      bm.pushToBuffer('sonnet', line1);
      bm.pushToBuffer('sonnet', line2);
      assert.equal(bm.getBuffer('sonnet').length, 2);
      assert.equal(bm.getBuffer('sonnet')[0].text, 'line 1');
      assert.equal(bm.getBuffer('sonnet')[1].text, 'line 2');
    });

    it('clearBuffer empties one agent buffer', () => {
      bm.pushToBuffer('sonnet', makeLine('a'));
      bm.pushToBuffer('codex', makeLine('b'));
      bm.clearBuffer('sonnet');
      assert.deepEqual(bm.getBuffer('sonnet'), []);
      assert.equal(bm.getBuffer('codex').length, 1);
    });

    it('clearAllBuffers empties all', () => {
      bm.pushToBuffer('sonnet', makeLine('a'));
      bm.pushToBuffer('codex', makeLine('b'));
      bm.pushToBuffer('opus', makeLine('c'));
      bm.clearAllBuffers();
      assert.deepEqual(bm.getBuffer('sonnet'), []);
      assert.deepEqual(bm.getBuffer('codex'), []);
      assert.deepEqual(bm.getBuffer('opus'), []);
    });
  });

  // ── Opus buffer flush ──

  describe('flushOpusBuffer', () => {
    it('flushes buffered lines to callback and clears', () => {
      const cb = makeMockCallbacks();
      bm.pushToBuffer('opus', makeLine('line A'));
      bm.pushToBuffer('opus', makeLine('line B'));

      bm.flushOpusBuffer(cb);

      assert.equal(cb.outputs.length, 2);
      assert.equal(cb.outputs[0].agent, 'opus');
      assert.equal(cb.outputs[0].line.text, 'line A');
      assert.equal(cb.outputs[1].line.text, 'line B');
      // Buffer is now empty
      assert.deepEqual(bm.getBuffer('opus'), []);
    });

    it('does nothing when buffer is empty', () => {
      const cb = makeMockCallbacks();
      bm.flushOpusBuffer(cb);
      assert.equal(cb.outputs.length, 0);
    });
  });

  // ── getOpusBufferedText ──

  describe('getOpusBufferedText', () => {
    it('returns joined stdout text', () => {
      bm.pushToBuffer('opus', makeLine('Hello'));
      bm.pushToBuffer('opus', makeLine('World'));
      bm.pushToBuffer('opus', makeLine('action', 'system'));
      assert.equal(bm.getOpusBufferedText(), 'Hello\nWorld');
    });

    it('returns empty string when no stdout', () => {
      bm.pushToBuffer('opus', makeLine('action', 'system'));
      assert.equal(bm.getOpusBufferedText(), '');
    });
  });

  // ── extractStatusSnippet ──

  describe('extractStatusSnippet', () => {
    it('extracts meaningful text', () => {
      assert.equal(
        bm.extractStatusSnippet('Analysing the database schema'),
        'Analysing the database schema',
      );
    });

    it('returns null for short text', () => {
      assert.equal(bm.extractStatusSnippet('ok'), null);
      assert.equal(bm.extractStatusSnippet(''), null);
    });

    it('skips relay tags', () => {
      assert.equal(bm.extractStatusSnippet('[TO:SONNET] do stuff'), null);
      assert.equal(bm.extractStatusSnippet('[FROM:OPUS] report'), null);
      assert.equal(bm.extractStatusSnippet('[TASK:add] something'), null);
    });

    it('skips code blocks', () => {
      assert.equal(bm.extractStatusSnippet('```typescript'), null);
    });

    it('skips formatting-only lines', () => {
      assert.equal(bm.extractStatusSnippet('─────────'), null);
      assert.equal(bm.extractStatusSnippet('***'), null);
    });

    it('skips internal instructions', () => {
      assert.equal(bm.extractStatusSnippet('Tu es Opus, directeur'), null);
      assert.equal(bm.extractStatusSnippet('IMPORTANT: ne fais pas ca'), null);
    });

    it('skips tool action lines', () => {
      assert.equal(bm.extractStatusSnippet('▸ Read file.ts'), null);
    });

    it('strips markdown headings', () => {
      assert.equal(bm.extractStatusSnippet('## Analysis Result'), 'Analysis Result');
    });

    it('picks first meaningful line in multiline text', () => {
      const text = '───\n[TASK:add] item\nActual content here\nMore stuff';
      assert.equal(bm.extractStatusSnippet(text), 'Actual content here');
    });
  });

  // ── maybeEmitStatusSnippet ──

  describe('maybeEmitStatusSnippet', () => {
    it('emits snippet when enough time has passed', () => {
      const cb = makeMockCallbacks();
      bm.maybeEmitStatusSnippet('sonnet', 'Working on the frontend', cb);
      assert.equal(cb.outputs.length, 1);
      assert.equal(cb.outputs[0].agent, 'sonnet');
      assert.ok(cb.outputs[0].line.text.includes('Working on the frontend'));
      assert.equal(cb.outputs[0].line.type, 'system');
    });

    it('throttles within SNIPPET_INTERVAL_MS', () => {
      const cb = makeMockCallbacks();
      bm.maybeEmitStatusSnippet('sonnet', 'First snippet text', cb);
      bm.maybeEmitStatusSnippet('sonnet', 'Second snippet text', cb);
      // Only first should have been emitted (within 1200ms)
      assert.equal(cb.outputs.length, 1);
    });

    it('does not emit for non-meaningful text', () => {
      const cb = makeMockCallbacks();
      bm.maybeEmitStatusSnippet('sonnet', '```', cb);
      assert.equal(cb.outputs.length, 0);
    });

    it('resetSnippetTime allows immediate re-emission', () => {
      const cb = makeMockCallbacks();
      bm.maybeEmitStatusSnippet('sonnet', 'First snippet text', cb);
      bm.resetSnippetTime('sonnet');
      bm.maybeEmitStatusSnippet('sonnet', 'Second snippet text', cb);
      assert.equal(cb.outputs.length, 2);
    });
  });

  // ── Reset ──

  describe('reset', () => {
    it('clears all buffers and snippet times', () => {
      const cb = makeMockCallbacks();
      bm.pushToBuffer('sonnet', makeLine('x'));
      bm.pushToBuffer('opus', makeLine('y'));
      bm.maybeEmitStatusSnippet('sonnet', 'Snippet text here', cb);

      bm.reset();

      assert.deepEqual(bm.getBuffer('sonnet'), []);
      assert.deepEqual(bm.getBuffer('opus'), []);
      // After reset, snippets should emit immediately again
      const cb2 = makeMockCallbacks();
      bm.maybeEmitStatusSnippet('sonnet', 'After reset snippet', cb2);
      assert.equal(cb2.outputs.length, 1);
    });
  });
});
