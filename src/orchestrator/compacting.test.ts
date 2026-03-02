import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestOrchestrator, type TestHarness } from '../test-utils/test-harness.js';

/**
 * Tests for compacting status handling throughout the orchestrator.
 * When an agent's context window is compacted, it emits 'compacting' status.
 * The orchestrator must treat 'compacting' as active (like 'running'):
 * - Don't trigger safety-net timeouts
 * - Don't close message groups
 * - Keep spinner visible
 */
describe('compacting status handling', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = createTestOrchestrator();
    await h.start();
  });

  afterEach(async () => {
    await h.orchestrator.stop();
  });

  it('compacting status is emitted to callbacks', async () => {
    h.log.statuses.length = 0;
    h.opus.setStatus('compacting');
    await h.flush();

    const compactingEvents = h.log.statuses.filter(
      (s) => s.agent === 'opus' && s.status === 'compacting',
    );
    assert.equal(compactingEvents.length, 1, 'Should emit compacting status');
  });

  it('compacting status transitions: idle → compacting → running', async () => {
    h.log.statuses.length = 0;

    // Simulate the transient compacting pattern
    h.codex.setStatus('running');
    h.codex.setStatus('compacting');
    h.codex.setStatus('running');
    h.codex.setStatus('waiting');
    await h.flush();

    const codexStatuses = h.log.statuses.filter((s) => s.agent === 'codex').map((s) => s.status);
    assert.ok(codexStatuses.includes('compacting'), 'Should include compacting');
    assert.ok(codexStatuses.includes('running'), 'Should include running');
  });

  it('compacting agent is treated as active for delegate tracking', async () => {
    // Start a delegation
    h.opus.emitText('[TO:SONNET] Analyse le code');
    await h.flush();

    // Sonnet is working and compacting happens
    h.sonnet.setStatus('running');
    h.sonnet.setStatus('compacting');

    // The orchestrator should still consider delegates pending
    assert.ok(
      h.orchestrator.hasPendingDelegates,
      'Delegates should still be pending during compacting',
    );

    // Sonnet finishes
    h.sonnet.emitText('[TO:OPUS] Done!');
    h.sonnet.setStatus('waiting');
    await h.flush();
  });

  it('compacting does not trigger safety-net auto-relay', async () => {
    // Start a delegation
    h.opus.emitText('[TO:CODEX] Build the API');
    await h.flush();

    // Codex is compacting (not idle/waiting/error)
    h.codex.setStatus('running');
    h.codex.setStatus('compacting');

    // Wait for safety-net timer (test uses fast 30ms)
    await new Promise((r) => setTimeout(r, 100));

    // Codex should NOT have been auto-relayed since it's compacting (active)
    const autoRelays = h.log.outputs.filter(
      (o) => o.agent === 'codex' && o.line.text.includes('auto-relay'),
    );
    assert.equal(autoRelays.length, 0, 'No auto-relay during compacting');
  });

  it('worker compacting during LIVE message delivery is treated as active', async () => {
    // Start delegation and make worker active
    h.opus.emitText('[TO:SONNET] Work on UI');
    await h.flush();
    h.sonnet.setStatus('running');

    // Sonnet enters compacting
    h.sonnet.setStatus('compacting');

    // Send a LIVE user message — should be delivered (agent is active)
    h.orchestrator.sendUserMessageLive('Update: change the color to blue', 'sonnet');
    await h.flush();

    // Sonnet should receive the urgent message since it's compacting (active)
    const urgentMsgs = h.sonnet.getUrgentMessages();
    assert.ok(urgentMsgs.length >= 1, 'LIVE message should be delivered to compacting agent');
  });

  it('all three agents can be compacting simultaneously', async () => {
    h.log.statuses.length = 0;
    h.opus.setStatus('compacting');
    h.sonnet.setStatus('compacting');
    h.codex.setStatus('compacting');
    await h.flush();

    const compactingEvents = h.log.statuses.filter((s) => s.status === 'compacting');
    assert.equal(compactingEvents.length, 3, 'All 3 agents should emit compacting');
  });
});
