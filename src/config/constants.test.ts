import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getMaxMessages, getFlushInterval, INDENT, BUBBLE_SIDE_MARGIN, MAX_READABLE_WIDTH, DOT_ACTIVE, MAX_VISIBLE_TODOS } from './constants.js';

describe('constants', () => {
  it('getMaxMessages returns a positive number', () => {
    const val = getMaxMessages();
    assert.strictEqual(typeof val, 'number');
    assert.ok(val > 0);
  });

  it('getFlushInterval returns a positive number', () => {
    const val = getFlushInterval();
    assert.strictEqual(typeof val, 'number');
    assert.ok(val > 0);
  });

  it('exports INDENT as 1-space string', () => {
    assert.strictEqual(INDENT, ' ');
  });

  it('exports BUBBLE_SIDE_MARGIN as number', () => {
    assert.strictEqual(typeof BUBBLE_SIDE_MARGIN, 'number');
  });

  it('exports MAX_READABLE_WIDTH as number', () => {
    assert.strictEqual(typeof MAX_READABLE_WIDTH, 'number');
    assert.ok(MAX_READABLE_WIDTH > 0);
  });

  it('exports DOT_ACTIVE as bullet character', () => {
    assert.strictEqual(DOT_ACTIVE, '\u2022');
  });

  it('exports MAX_VISIBLE_TODOS as number', () => {
    assert.strictEqual(typeof MAX_VISIBLE_TODOS, 'number');
    assert.ok(MAX_VISIBLE_TODOS > 0);
  });
});
