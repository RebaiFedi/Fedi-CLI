import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectClaude, detectCodex, detectAll } from './detect.js';

describe('detectClaude', () => {
  it('returns CLIInfo with available boolean', async () => {
    const result = await detectClaude();
    assert.strictEqual(typeof result.available, 'boolean');
    if (result.available) {
      assert.ok(result.path, 'path should be set when available');
    }
  });
});

describe('detectCodex', () => {
  it('returns CLIInfo with available boolean', async () => {
    const result = await detectCodex();
    assert.strictEqual(typeof result.available, 'boolean');
  });
});

describe('detectAll', () => {
  it('returns both claude and codex info', async () => {
    const result = await detectAll();
    assert.ok('claude' in result);
    assert.ok('codex' in result);
    assert.strictEqual(typeof result.claude.available, 'boolean');
    assert.strictEqual(typeof result.codex.available, 'boolean');
  });
});
