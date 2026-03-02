import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  outputToEntries,
  extractTasks,
  RELAY_LINE_RE,
  TASK_TAG_LINE_RE,
} from './output-transform.js';
import type { OutputLine } from '../agents/types.js';

// ── Helper ──────────────────────────────────────────────────────────────────

function mkLine(text: string, type: OutputLine['type'] = 'stdout'): OutputLine {
  return { text, timestamp: Date.now(), type };
}

// ── outputToEntries ─────────────────────────────────────────────────────────

describe('outputToEntries', () => {
  it('converts stdout to text entries', () => {
    const entries = outputToEntries(mkLine('Hello world'));
    assert.ok(entries.length > 0);
    assert.ok(entries.some((e) => e.kind === 'text'));
  });

  it('converts system to action entry', () => {
    const entries = outputToEntries(mkLine('Read src/app.ts', 'system'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'action');
    assert.equal(entries[0].text, 'Read src/app.ts');
  });

  it('converts info to info entry', () => {
    const entries = outputToEntries(mkLine('some info', 'info'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'info');
  });

  it('returns empty for relay type', () => {
    const entries = outputToEntries(mkLine('relayed content', 'relay'));
    assert.equal(entries.length, 0);
  });

  it('filters out relay tag lines from stdout', () => {
    const entries = outputToEntries(mkLine('[TO:SONNET] do something'));
    assert.equal(entries.length, 0);
  });

  it('filters out TASK tag lines from stdout', () => {
    const entries = outputToEntries(mkLine('[TASK:add] build the page'));
    assert.equal(entries.length, 0);
  });

  it('returns empty for whitespace-only text', () => {
    const entries = outputToEntries(mkLine('   \n  \n  '));
    assert.equal(entries.length, 0);
  });

  it('converts Codex checkpoint to action', () => {
    const entries = outputToEntries(
      mkLine('[CODEX:checkpoint] File create: src/app.ts', 'checkpoint'),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'action');
    assert.match(entries[0].text, /create src\/app\.ts/);
  });

  it('hides internal CODEX tags (started, done)', () => {
    const entries = outputToEntries(mkLine('[CODEX:done] Turn completed', 'checkpoint'));
    assert.equal(entries.length, 0);
  });

  it('suppresses Running: checkpoints', () => {
    const entries = outputToEntries(mkLine('[CODEX:checkpoint] Running: ls', 'checkpoint'));
    assert.equal(entries.length, 0);
  });

  it('uses rich tool display when toolMeta is present', () => {
    const line: OutputLine = {
      text: 'Edit src/app.ts',
      timestamp: Date.now(),
      type: 'system',
      toolMeta: {
        tool: 'edit',
        file: 'src/app.ts',
        oldLines: ['old line'],
        newLines: ['new line'],
        startLine: 10,
      },
    };
    const entries = outputToEntries(line);
    assert.ok(entries.some((e) => e.kind === 'tool-header'));
    assert.ok(entries.some((e) => e.kind === 'diff-old'));
    assert.ok(entries.some((e) => e.kind === 'diff-new'));
  });
});

// ── regex patterns ──────────────────────────────────────────────────────────

describe('regex patterns', () => {
  it('RELAY_LINE_RE matches relay tags at start of line', () => {
    assert.ok(RELAY_LINE_RE.test('[TO:SONNET] do this'));
    assert.ok(RELAY_LINE_RE.test('  [TO:CODEX] do that'));
    assert.ok(!RELAY_LINE_RE.test('I told [TO:SONNET] to do this'));
  });

  it('TASK_TAG_LINE_RE matches task tags', () => {
    assert.ok(TASK_TAG_LINE_RE.test('[TASK:add] something'));
    assert.ok(TASK_TAG_LINE_RE.test('[TASK:done] something'));
    assert.ok(!TASK_TAG_LINE_RE.test('Some text [TASK:add] later'));
  });
});

// ── extractTasks ────────────────────────────────────────────────────────────

describe('extractTasks', () => {
  it('extracts add tasks', () => {
    const { adds, dones } = extractTasks('[TASK:add] Build the login page');
    assert.equal(adds.length, 1);
    assert.match(adds[0], /Build the login page/);
    assert.equal(dones.length, 0);
  });

  it('extracts done tasks', () => {
    const { adds, dones } = extractTasks('[TASK:done] Login page done');
    assert.equal(adds.length, 0);
    assert.equal(dones.length, 1);
    assert.match(dones[0], /Login page done/);
  });

  it('extracts multiple tasks from multiline', () => {
    const text = `[TASK:add] Task one\n[TASK:add] Task two\n[TASK:done] Task three`;
    const { adds, dones } = extractTasks(text);
    assert.equal(adds.length, 2);
    assert.equal(dones.length, 1);
  });

  it('ignores very short task text', () => {
    const { adds } = extractTasks('[TASK:add] ab');
    assert.equal(adds.length, 0);
  });

  it('truncates long task text to 80 chars', () => {
    const longText = 'A'.repeat(100);
    const { adds } = extractTasks(`[TASK:add] ${longText}`);
    assert.equal(adds.length, 1);
    assert.ok(adds[0].length <= 80);
  });
});
