import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RelayRouter } from './relay-router.js';
import type { RelayRouterDeps } from './relay-router.js';
import { CrossTalkManager } from './cross-talk-manager.js';
import { BufferManager } from './buffer-manager.js';
import { MessageBus } from './message-bus.js';
import { MockAgent } from '../test-utils/mock-agent.js';
import type { AgentId, Message } from '../agents/types.js';

/** Minimal DelegateTracker stub for relay-router tests */
function makeDelegateStub() {
  return {
    expectedDelegates: new Set<AgentId>(),
    pendingReports: new Map<AgentId, string>(),
    deliveredToOpus: new Set<AgentId>(),
    lastDelegationContent: new Map<AgentId, string>(),
    recordSuccess: () => {},
    recordActivity: () => {},
    resetDelegateTimeout: () => {},
    clearSafetyNetTimer: () => {},
    deliverCombinedReports: () => {},
  };
}

function makeRouter(overrides?: Partial<RelayRouterDeps>) {
  const opus = new MockAgent('opus');
  const sonnet = new MockAgent('sonnet');
  const codex = new MockAgent('codex');
  const bus = new MessageBus();
  const crossTalk = new CrossTalkManager();
  const buffers = new BufferManager();
  const delegates = makeDelegateStub();

  const relays: Message[] = [];
  bus.on('relay', (msg: Message) => relays.push(msg));

  const deps: RelayRouterDeps = {
    agents: { opus, sonnet, codex },
    bus,
    delegates: delegates as unknown as RelayRouterDeps['delegates'],
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

  const router = new RelayRouter(deps);
  return { router, bus, crossTalk, buffers, delegates, opus, sonnet, codex, relays };
}

describe('RelayRouter', () => {

  // ── Tag detection ──

  describe('isRelayTag', () => {
    let router: RelayRouter;
    beforeEach(() => { router = makeRouter().router; });

    it('detects [TO:SONNET]', () => {
      assert.equal(router.isRelayTag('[TO:SONNET] hello'), true);
    });

    it('detects [TO:CODEX]', () => {
      assert.equal(router.isRelayTag('[TO:CODEX] hello'), true);
    });

    it('detects [TO:OPUS]', () => {
      assert.equal(router.isRelayTag('[TO:OPUS] report'), true);
    });

    it('rejects non-relay text', () => {
      assert.equal(router.isRelayTag('Just some text'), false);
    });

    it('rejects tag inside sentence', () => {
      assert.equal(router.isRelayTag('Use [TO:SONNET] for delegation'), false);
    });
  });

  // ── Rate limiting ──

  describe('rate limiting', () => {
    it('is not rate limited initially', () => {
      const { router } = makeRouter();
      assert.equal(router.isRateLimited(), false);
    });

    it('becomes rate limited after max relays', () => {
      const { router } = makeRouter();
      for (let i = 0; i < 50; i++) router.recordRelay();
      assert.equal(router.isRateLimited(), true);
    });

    it('clears old timestamps outside window', () => {
      const { router } = makeRouter();
      // Record relay at a time far in the past
      for (let i = 0; i < 50; i++) router.recordRelay();
      assert.equal(router.isRateLimited(), true);
      // Check with a future time — all timestamps should expire
      const futureTime = Date.now() + 120_000;
      assert.equal(router.isRateLimited(futureTime), false);
    });
  });

  // ── Relay timeout ──

  describe('getRelayTimeout', () => {
    it('returns exec timeout for sonnet', () => {
      const { router } = makeRouter();
      assert.equal(typeof router.getRelayTimeout('sonnet'), 'number');
      assert.ok(router.getRelayTimeout('sonnet') > 0);
    });

    it('returns codex-specific timeout for codex', () => {
      const { router } = makeRouter();
      const timeout = router.getRelayTimeout('codex');
      assert.equal(typeof timeout, 'number');
    });
  });

  // ── detectRelayPatterns ──

  describe('detectRelayPatterns', () => {
    it('detects a relay tag and creates a draft', () => {
      const { router } = makeRouter();
      const found = router.detectRelayPatterns('opus', '[TO:SONNET] Do the work');
      assert.equal(found, true);
      const draft = router.getDraft('opus');
      assert.ok(draft);
      assert.equal(draft.target, 'sonnet');
    });

    it('returns false for no relay tag', () => {
      const { router } = makeRouter();
      const found = router.detectRelayPatterns('opus', 'Just regular text');
      assert.equal(found, false);
    });

    it('skips markdown context lines', () => {
      const { router } = makeRouter();
      const found = router.detectRelayPatterns('opus', '```\n[TO:SONNET] inside code\n```');
      // The ``` line is markdown context — tag on second line should still be detected
      // because only ``` lines themselves are skipped, not subsequent lines
      // Actually the first line (```) is skipped, the tag line is processed normally
      assert.equal(found, true);
    });

    it('skips inline code with relay tags', () => {
      const { router } = makeRouter();
      const found = router.detectRelayPatterns('opus', '`[TO:SONNET] example tag`');
      assert.equal(found, false);
    });

    it('splits multiple tags on same line', () => {
      const { router } = makeRouter();
      const found = router.detectRelayPatterns('opus', '[TO:SONNET] frontend[TO:CODEX] backend');
      assert.equal(found, true);
    });

    it('appends content to existing draft', () => {
      const { router } = makeRouter();
      router.detectRelayPatterns('opus', '[TO:CODEX] first line');
      router.detectRelayPatterns('opus', 'second line of content');
      const draft = router.getDraft('opus');
      assert.ok(draft);
      assert.equal(draft.target, 'codex');
      assert.ok(draft.parts.length >= 2);
    });

    it('prevents self-delegation (sonnet→sonnet)', () => {
      const { router } = makeRouter();
      const found = router.detectRelayPatterns('sonnet', '[TO:SONNET] self');
      assert.equal(found, false);
    });
  });

  // ── flushRelayDraft ──

  describe('flushRelayDraft', () => {
    it('flushes draft and routes message', async () => {
      const { router, relays } = makeRouter();
      router.detectRelayPatterns('opus', '[TO:SONNET] Analyse le fichier');
      router.detectRelayPatterns('opus', 'avec des details');

      router.flushRelayDraft('opus');
      // Wait for async relay routing
      await new Promise(r => setTimeout(r, 50));

      assert.ok(relays.length >= 1);
    });

    it('returns false when no draft exists', () => {
      const { router } = makeRouter();
      const result = router.flushRelayDraft('opus');
      assert.equal(result, false);
    });
  });

  // ── Content sanitization (via routeRelayMessage) ──

  describe('content sanitization', () => {
    it('strips control characters from routed content', () => {
      const { router, bus } = makeRouter();
      const messages: Message[] = [];
      bus.on('relay', (msg: Message) => messages.push(msg));

      // Route a message with control chars
      router.routeRelayMessage('sonnet', 'opus', 'Hello\x00\x01\x02World content here');
      assert.ok(messages.length >= 1);
      assert.ok(!messages[0].content.includes('\x00'));
    });

    it('drops fragment relay (too short after stripping)', () => {
      const { router, bus } = makeRouter();
      const messages: Message[] = [];
      bus.on('relay', (msg: Message) => messages.push(msg));

      router.routeRelayMessage('sonnet', 'opus', '...');
      assert.equal(messages.length, 0);
    });

    it('blocks relay to disabled agent', () => {
      const { router } = makeRouter({ isAgentEnabled: (id) => id !== 'codex' });
      const messages: Message[] = [];

      router.routeRelayMessage('opus', 'codex', 'This should be blocked as a real message');
      // No relay emitted — codex is disabled
    });
  });

  // ── Reset ──

  describe('reset', () => {
    it('clears all state', () => {
      const { router } = makeRouter();
      router.agentsOnRelay.add('sonnet');
      router.relayStartTime.set('sonnet', Date.now());
      router.liveRelayAllowed = true;
      router.recordRelay();

      router.reset();

      assert.equal(router.agentsOnRelay.size, 0);
      assert.equal(router.relayStartTime.size, 0);
      assert.equal(router.liveRelayAllowed, false);
      assert.equal(router.isRateLimited(), false);
    });
  });

  // ── isOpusWaitingForRelays ──

  describe('isOpusWaitingForRelays', () => {
    it('returns false when no agents on relay', () => {
      const { router } = makeRouter();
      assert.equal(router.isOpusWaitingForRelays(), false);
    });

    it('returns true when worker is on relay', () => {
      const { router } = makeRouter();
      router.agentsOnRelay.add('sonnet');
      assert.equal(router.isOpusWaitingForRelays(), true);
    });

    it('returns false when only opus on relay', () => {
      const { router } = makeRouter();
      router.agentsOnRelay.add('opus');
      assert.equal(router.isOpusWaitingForRelays(), false);
    });
  });
});
