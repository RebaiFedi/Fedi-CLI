import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CrossTalkManager } from './cross-talk-manager.js';
import { loadUserConfig } from '../config/user-config.js';

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

  it('reaches limit at maxPerRound', () => {
    const max = loadUserConfig().maxCrossTalkPerRound;
    for (let i = 0; i < max; i++) ct.increment();
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

  // ── Turn-based speaking ──

  it('canSpeak returns true when nobody is speaking', () => {
    assert.equal(ct.canSpeak('sonnet'), true);
    assert.equal(ct.canSpeak('codex'), true);
  });

  it('canSpeak returns true for the current speaker', () => {
    ct.claimTurn('sonnet');
    assert.equal(ct.canSpeak('sonnet'), true);
  });

  it('canSpeak returns false for another agent when turn is taken', () => {
    ct.claimTurn('sonnet');
    assert.equal(ct.canSpeak('codex'), false);
  });

  it('releaseTurn allows another agent to speak', () => {
    ct.claimTurn('sonnet');
    assert.equal(ct.canSpeak('codex'), false);
    ct.releaseTurn();
    assert.equal(ct.canSpeak('codex'), true);
  });

  it('getCurrentSpeaker returns the correct agent', () => {
    assert.equal(ct.getCurrentSpeaker(), null);
    ct.claimTurn('codex');
    assert.equal(ct.getCurrentSpeaker(), 'codex');
  });

  // ── Pending queue ──

  it('queueMessage + dequeuePending full cycle', () => {
    assert.equal(ct.hasPendingMessage(), false);
    ct.queueMessage('codex', 'sonnet', 'Hey check this API');
    assert.equal(ct.hasPendingMessage(), true);
    const msg = ct.dequeuePending();
    assert.ok(msg);
    assert.equal(msg.from, 'codex');
    assert.equal(msg.target, 'sonnet');
    assert.equal(msg.content, 'Hey check this API');
    assert.equal(ct.hasPendingMessage(), false);
  });

  it('hasPendingMessage returns false when empty', () => {
    assert.equal(ct.hasPendingMessage(), false);
  });

  it('dequeuePending returns null when empty', () => {
    assert.equal(ct.dequeuePending(), null);
  });

  // ── Bulk operations ──

  it('reset clears everything including turn and queue', () => {
    ct.increment();
    ct.increment();
    ct.setOnCrossTalk('sonnet');
    ct.setOnCrossTalk('codex');
    ct.setAwaitingReply('sonnet');
    ct.claimTurn('sonnet');
    ct.queueMessage('codex', 'sonnet', 'queued msg');

    ct.reset();

    assert.equal(ct.crossTalkCount, 0);
    assert.equal(ct.isOnCrossTalk('sonnet'), false);
    assert.equal(ct.isOnCrossTalk('codex'), false);
    assert.equal(ct.isAwaitingReply('sonnet'), false);
    assert.equal(ct.getCurrentSpeaker(), null);
    assert.equal(ct.hasPendingMessage(), false);
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

  it('clearAgent releases turn if agent was the speaker', () => {
    ct.claimTurn('sonnet');
    assert.equal(ct.getCurrentSpeaker(), 'sonnet');
    ct.clearAgent('sonnet');
    assert.equal(ct.getCurrentSpeaker(), null);
  });

  it('clearAgent does not release turn if agent was not the speaker', () => {
    ct.claimTurn('codex');
    ct.clearAgent('sonnet');
    assert.equal(ct.getCurrentSpeaker(), 'codex');
  });

  it('clearAgent clears pending queue if agent was the sender', () => {
    ct.queueMessage('sonnet', 'codex', 'hello');
    assert.equal(ct.hasPendingMessage(), true);
    ct.clearAgent('sonnet');
    assert.equal(ct.hasPendingMessage(), false);
  });

  it('clearAgent does not clear pending queue if agent was not the sender', () => {
    ct.queueMessage('sonnet', 'codex', 'hello');
    ct.clearAgent('codex');
    assert.equal(ct.hasPendingMessage(), true);
  });
});
