import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CrossTalkManager } from './cross-talk-manager.js';

describe('CrossTalkManager', () => {
  let ct: CrossTalkManager;

  beforeEach(() => {
    ct = new CrossTalkManager();
  });

  // ── Count & limit ──

  it('starts at 0', () => {
    assert.equal(ct.crossTalkCount, 0);
    assert.equal(ct.isAtLimit(), false);
  });

  it('increments count', () => {
    ct.increment();
    ct.increment();
    assert.equal(ct.crossTalkCount, 2);
  });

  it('reaches limit at maxPerRound (default 20)', () => {
    for (let i = 0; i < 20; i++) ct.increment();
    assert.equal(ct.isAtLimit(), true);
  });

  it('resetCount sets count back to 0', () => {
    for (let i = 0; i < 5; i++) ct.increment();
    ct.resetCount();
    assert.equal(ct.crossTalkCount, 0);
    assert.equal(ct.isAtLimit(), false);
  });

  // ── On-cross-talk mute ──

  it('tracks mute state per agent', () => {
    assert.equal(ct.isOnCrossTalk('sonnet'), false);
    ct.setOnCrossTalk('sonnet', 1000);
    assert.equal(ct.isOnCrossTalk('sonnet'), true);
    assert.equal(ct.getCrossTalkTime('sonnet'), 1000);
  });

  it('clearOnCrossTalk removes mute', () => {
    ct.setOnCrossTalk('codex', 2000);
    ct.clearOnCrossTalk('codex');
    assert.equal(ct.isOnCrossTalk('codex'), false);
    assert.equal(ct.getCrossTalkTime('codex'), undefined);
  });

  it('setOnCrossTalk defaults to Date.now()', () => {
    const before = Date.now();
    ct.setOnCrossTalk('sonnet');
    const after = Date.now();
    const time = ct.getCrossTalkTime('sonnet')!;
    assert.ok(time >= before && time <= after);
  });

  // ── Awaiting reply ──

  it('tracks awaiting reply state', () => {
    assert.equal(ct.isAwaitingReply('sonnet'), false);
    ct.setAwaitingReply('sonnet');
    assert.equal(ct.isAwaitingReply('sonnet'), true);
    ct.clearAwaitingReply('sonnet');
    assert.equal(ct.isAwaitingReply('sonnet'), false);
  });

  // ── Bulk operations ──

  it('reset clears everything', () => {
    ct.increment();
    ct.increment();
    ct.setOnCrossTalk('sonnet');
    ct.setOnCrossTalk('codex');
    ct.setAwaitingReply('sonnet');

    ct.reset();

    assert.equal(ct.crossTalkCount, 0);
    assert.equal(ct.isOnCrossTalk('sonnet'), false);
    assert.equal(ct.isOnCrossTalk('codex'), false);
    assert.equal(ct.isAwaitingReply('sonnet'), false);
  });

  it('clearAgent clears only that agent', () => {
    ct.setOnCrossTalk('sonnet');
    ct.setOnCrossTalk('codex');
    ct.setAwaitingReply('sonnet');
    ct.setAwaitingReply('codex');

    ct.clearAgent('sonnet');

    assert.equal(ct.isOnCrossTalk('sonnet'), false);
    assert.equal(ct.isAwaitingReply('sonnet'), false);
    // codex untouched
    assert.equal(ct.isOnCrossTalk('codex'), true);
    assert.equal(ct.isAwaitingReply('codex'), true);
  });
});
