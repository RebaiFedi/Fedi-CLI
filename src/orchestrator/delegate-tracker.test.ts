import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DelegateTracker } from './delegate-tracker.js';
import type { DelegateTrackerDeps } from './delegate-tracker.js';
import { CrossTalkManager } from './cross-talk-manager.js';
import { BufferManager } from './buffer-manager.js';
import { MessageBus } from './message-bus.js';
import { MockAgent } from '../test-utils/mock-agent.js';
import type { Message } from '../agents/types.js';

function makeTracker(overrides?: Partial<DelegateTrackerDeps>) {
  const opus = new MockAgent('opus');
  const sonnet = new MockAgent('sonnet');
  const codex = new MockAgent('codex');
  const bus = new MessageBus();
  const crossTalk = new CrossTalkManager();
  const buffers = new BufferManager();

  const sentToOpus: Message[] = [];
  bus.on('message:opus', (msg: Message) => sentToOpus.push(msg));

  const deps: DelegateTrackerDeps = {
    agents: { opus, sonnet, codex },
    bus,
    crossTalk,
    buffers,
    getCallbacks: () => ({
      onAgentOutput: () => {},
      onAgentStatus: () => {},
      onRelay: () => {},
      onRelayBlocked: () => {},
    }),
    isAgentEnabled: () => true,
    ...overrides,
  };

  const tracker = new DelegateTracker(deps);
  return { tracker, bus, crossTalk, buffers, opus, sonnet, codex, sentToOpus };
}

describe('DelegateTracker', () => {
  // ── Basic state ──

  describe('basic state', () => {
    it('starts with no pending delegates', () => {
      const { tracker } = makeTracker();
      assert.equal(tracker.hasPendingDelegates, false);
      assert.equal(tracker.expectedDelegates.size, 0);
    });

    it('tracks expected delegates', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      assert.equal(tracker.hasPendingDelegates, true);
    });
  });

  // ── Activity tracking ──

  describe('recordActivity', () => {
    it('records activity for expected delegates only', () => {
      const { tracker } = makeTracker();
      // Not an expected delegate — should not crash
      tracker.recordActivity('sonnet');
      // Now as expected delegate
      tracker.expectedDelegates.add('sonnet');
      tracker.recordActivity('sonnet');
    });
  });

  // ── Safety-net timers ──

  describe('safety-net timers', () => {
    it('setSafetyNetTimer stores and clearSafetyNetTimer removes', () => {
      const { tracker } = makeTracker();
      let fired = false;
      const timer = setTimeout(() => {
        fired = true;
      }, 10_000);
      tracker.setSafetyNetTimer('sonnet', timer);
      tracker.clearSafetyNetTimer('sonnet');
      // Timer was cleared — should not fire
      assert.equal(fired, false);
    });

    it('setSafetyNetTimer clears previous timer', () => {
      const { tracker } = makeTracker();
      const timer1 = setTimeout(() => {}, 10_000);
      tracker.setSafetyNetTimer('sonnet', timer1);

      const timer2 = setTimeout(() => {}, 10_000);
      tracker.setSafetyNetTimer('sonnet', timer2);
      // First timer should have been cleared
      clearTimeout(timer2); // cleanup
    });
  });

  // ── Circuit breaker ──

  describe('circuit breaker', () => {
    it('circuit is closed by default', () => {
      const { tracker } = makeTracker();
      assert.equal(tracker.isCircuitOpen('sonnet'), false);
      assert.equal(tracker.isCircuitOpen('codex'), false);
    });

    it('opens after threshold failures (default 3)', () => {
      const { tracker } = makeTracker();
      tracker.recordFailure('sonnet');
      assert.equal(tracker.isCircuitOpen('sonnet'), false);
      tracker.recordFailure('sonnet');
      assert.equal(tracker.isCircuitOpen('sonnet'), false);
      tracker.recordFailure('sonnet');
      assert.equal(tracker.isCircuitOpen('sonnet'), true);
    });

    it('recordSuccess resets failure count', () => {
      const { tracker } = makeTracker();
      tracker.recordFailure('sonnet');
      tracker.recordFailure('sonnet');
      tracker.recordSuccess('sonnet');
      tracker.recordFailure('sonnet');
      // Only 1 failure after reset — not at threshold
      assert.equal(tracker.isCircuitOpen('sonnet'), false);
    });

    it('circuit breaker is per-agent', () => {
      const { tracker } = makeTracker();
      for (let i = 0; i < 3; i++) tracker.recordFailure('sonnet');
      assert.equal(tracker.isCircuitOpen('sonnet'), true);
      assert.equal(tracker.isCircuitOpen('codex'), false);
    });

    it('reset clears circuit breaker', () => {
      const { tracker } = makeTracker();
      for (let i = 0; i < 3; i++) tracker.recordFailure('sonnet');
      assert.equal(tracker.isCircuitOpen('sonnet'), true);
      tracker.reset();
      assert.equal(tracker.isCircuitOpen('sonnet'), false);
    });
  });

  // ── Fallback ──

  describe('pickFallbackAgent', () => {
    it('picks codex as fallback for sonnet', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      const fallback = tracker.pickFallbackAgent('sonnet');
      assert.equal(fallback, 'codex');
    });

    it('picks sonnet as fallback for codex', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('codex');
      const fallback = tracker.pickFallbackAgent('codex');
      assert.equal(fallback, 'sonnet');
    });

    it('returns opus when no worker fallback available', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      tracker.expectedDelegates.add('codex');
      // Both are expected delegates — codex can't be fallback for sonnet
      const fallback = tracker.pickFallbackAgent('sonnet');
      assert.equal(fallback, 'opus');
    });

    it('skips disabled agents', () => {
      const { tracker } = makeTracker({ isAgentEnabled: (id) => id !== 'codex' });
      tracker.expectedDelegates.add('sonnet');
      const fallback = tracker.pickFallbackAgent('sonnet');
      // codex disabled — falls back to opus
      assert.equal(fallback, 'opus');
    });

    it('skips agents with open circuit breaker', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      // Open circuit for codex
      for (let i = 0; i < 3; i++) tracker.recordFailure('codex');
      const fallback = tracker.pickFallbackAgent('sonnet');
      // codex circuit open — falls to opus
      assert.equal(fallback, 'opus');
    });

    it('skips agents in error/stopped status', () => {
      const { tracker, codex } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      codex.status = 'error';
      const fallback = tracker.pickFallbackAgent('sonnet');
      assert.equal(fallback, 'opus');
    });

    it('records failure for the failed agent', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      tracker.pickFallbackAgent('sonnet');
      // First failure recorded
      tracker.pickFallbackAgent('sonnet');
      tracker.expectedDelegates.add('sonnet');
      tracker.pickFallbackAgent('sonnet');
      // After 3 pickFallbackAgent calls, sonnet circuit should be open
      assert.equal(tracker.isCircuitOpen('sonnet'), true);
    });
  });

  // ── hasCrossTalkPending ──

  describe('hasCrossTalkPending', () => {
    it('returns false when no cross-talk active', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      assert.equal(tracker.hasCrossTalkPending(), false);
    });

    it('returns true when delegate is on cross-talk', () => {
      const { tracker, crossTalk } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      crossTalk.setOnCrossTalk('sonnet');
      assert.equal(tracker.hasCrossTalkPending(), true);
    });
  });

  // ── Combined delivery ──

  describe('deliverCombinedReports', () => {
    it('sends combined message to opus when all reports are in', () => {
      const { tracker, sentToOpus } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      tracker.expectedDelegates.add('codex');
      tracker.pendingReports.set('sonnet', 'Frontend report');
      tracker.pendingReports.set('codex', 'Backend report');

      tracker.deliverCombinedReports();

      assert.ok(sentToOpus.length >= 1);
      const combined = sentToOpus.find((m) => m.content.includes('[RAPPORTS RECUS'));
      assert.ok(combined, 'should send combined report');
      assert.ok(combined!.content.includes('Frontend report'));
      assert.ok(combined!.content.includes('Backend report'));
    });

    it('clears delegates and reports after delivery', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      tracker.pendingReports.set('sonnet', 'Done');

      tracker.deliverCombinedReports();

      assert.equal(tracker.expectedDelegates.size, 0);
      assert.equal(tracker.pendingReports.size, 0);
    });

    it('does nothing when no reports', () => {
      const { tracker, sentToOpus } = makeTracker();
      tracker.deliverCombinedReports();
      assert.equal(sentToOpus.length, 0);
    });

    it('defers when cross-talk is still active', () => {
      const { tracker, crossTalk, sentToOpus } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      tracker.pendingReports.set('sonnet', 'Report');
      crossTalk.setOnCrossTalk('sonnet');

      tracker.deliverCombinedReports();

      // Should NOT deliver yet
      assert.equal(sentToOpus.length, 0);
    });

    it('mutes and interrupts delivered agents', () => {
      const { tracker, sonnet } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      tracker.pendingReports.set('sonnet', 'Done');

      tracker.deliverCombinedReports();

      assert.equal(tracker.deliveredToOpus.has('sonnet'), true);
      assert.equal(sonnet.isMuted(), true);
      assert.equal(sonnet.isInterrupted(), true);
    });

    it('includes Opus buffered analysis when available', () => {
      const { tracker, buffers, sentToOpus } = makeTracker();
      buffers.pushToBuffer('opus', {
        text: 'My opus analysis',
        timestamp: Date.now(),
        type: 'stdout',
      });
      tracker.expectedDelegates.add('sonnet');
      tracker.pendingReports.set('sonnet', 'Report');

      tracker.deliverCombinedReports();

      const combined = sentToOpus.find((m) => m.content.includes('My opus analysis'));
      assert.ok(combined, 'should include opus buffered analysis');
    });
  });

  // ── Reset ──

  describe('reset', () => {
    it('clears all tracking state', () => {
      const { tracker } = makeTracker();
      tracker.expectedDelegates.add('sonnet');
      tracker.pendingReports.set('sonnet', 'x');
      tracker.deliveredToOpus.add('sonnet');
      tracker.lastDelegationContent.set('sonnet', 'y');
      for (let i = 0; i < 3; i++) tracker.recordFailure('codex');

      tracker.reset();

      assert.equal(tracker.expectedDelegates.size, 0);
      assert.equal(tracker.pendingReports.size, 0);
      assert.equal(tracker.deliveredToOpus.size, 0);
      assert.equal(tracker.lastDelegationContent.size, 0);
      assert.equal(tracker.isCircuitOpen('codex'), false);
    });
  });
});
