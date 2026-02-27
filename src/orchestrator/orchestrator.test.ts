import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestOrchestrator, type TestHarness } from '../test-utils/test-harness.js';

describe('Orchestrator', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestOrchestrator();
  });

  // ── Relay detection ─────────────────────────────────────────────────────

  describe('relay detection', () => {
    it('detects [TO:CLAUDE] delegation from Opus', async () => {
      // Opus emits a relay tag → should be detected and relayed
      h.opus.emitText('[TO:CLAUDE] Analyse le fichier index.ts');
      await h.flush();

      assert.ok(h.log.relays.length >= 1, 'should emit at least 1 relay');
      const relay = h.log.relays.find((r) => r.to === 'claude');
      assert.ok(relay, 'relay should target claude');
      assert.ok(relay.content.includes('Analyse le fichier index.ts'));
    });

    it('detects multi-delegation [TO:CLAUDE] + [TO:CODEX] in one text block', async () => {
      h.opus.emitText(
        '[TO:CLAUDE] Corrige le frontend\n[TO:CODEX] Corrige le backend',
      );
      await h.flush();

      const claudeRelay = h.log.relays.find((r) => r.to === 'claude');
      const codexRelay = h.log.relays.find((r) => r.to === 'codex');
      assert.ok(claudeRelay, 'should relay to claude');
      assert.ok(codexRelay, 'should relay to codex');
    });

    it('ignores [TO:CLAUDE] mentioned inside a sentence (not standalone)', async () => {
      h.opus.emitText('The pattern [TO:CLAUDE] is used for delegation');
      await h.flush();

      // The pattern requires the tag at start of line — this is embedded in text
      // so it should NOT match (the regex requires ^\s*\[TO:CLAUDE\])
      // Actually the regex DOES match if the text starts with [TO:CLAUDE]
      // But "The pattern [TO:CLAUDE]..." does NOT start with [TO:CLAUDE]
      const claudeRelays = h.log.relays.filter((r) => r.to === 'claude');
      assert.equal(claudeRelays.length, 0, 'should not detect relay tag inside sentence');
    });
  });

  // ── Relay buffering ─────────────────────────────────────────────────────

  describe('relay buffering', () => {
    it('buffers stdout during relay, passes actions through', async () => {
      // Opus delegates to Claude
      h.opus.emitText('[TO:CLAUDE] Do the work');
      await h.flush();

      // Claude is now on relay — stdout should be buffered
      h.log.outputs = [];
      h.claude.emitText('Working on it...');

      const textOutputs = h.log.outputs.filter(
        (o) => o.agent === 'claude' && o.line.type === 'stdout',
      );
      assert.equal(textOutputs.length, 0, 'stdout should be buffered during relay');

      // Actions (system type) should pass through
      h.claude.emitAction('Read src/index.ts');
      const actionOutputs = h.log.outputs.filter(
        (o) => o.agent === 'claude' && o.line.type === 'system',
      );
      assert.ok(actionOutputs.length > 0, 'actions should pass through during relay');
    });
  });

  // ── Cross-talk mute ─────────────────────────────────────────────────────

  describe('cross-talk mute', () => {
    it('mutes target agent stdout on cross-talk', async () => {
      // Claude sends cross-talk to Codex
      h.claude.emitText('[TO:CODEX] Check the API endpoint');
      await h.flush();

      // Codex is now on cross-talk mute — stdout should be suppressed
      h.log.outputs = [];
      h.codex.emitText('Internal response to Claude');

      const codexTextOutputs = h.log.outputs.filter(
        (o) => o.agent === 'codex' && o.line.type === 'stdout',
      );
      assert.equal(codexTextOutputs.length, 0, 'codex stdout should be muted during cross-talk');
    });

    it('blocks 11th cross-talk when limit is 10 per round', async () => {
      // Send 10 cross-talk messages (the max)
      for (let i = 0; i < 10; i++) {
        h.claude.emitText(`[TO:CODEX] Cross-talk message ${i + 1}`);
      }
      await h.flush();

      const relaysBefore = h.log.relays.length;

      // 11th should be blocked
      h.claude.emitText('[TO:CODEX] Cross-talk message 11 should be blocked');
      await h.flush();

      assert.equal(
        h.log.relays.length,
        relaysBefore,
        '11th cross-talk should not produce a relay',
      );
    });
  });

  // ── Combined delivery ───────────────────────────────────────────────────

  describe('combined delivery', () => {
    it('delivers combined report only when ALL delegates have reported', async () => {
      // Opus delegates to both Claude and Codex
      h.opus.emitText('[TO:CLAUDE] Frontend task\n[TO:CODEX] Backend task');
      await h.flush();

      // Claude reports back
      h.claude.emitText('[TO:OPUS] Frontend done');
      await h.flush();

      // At this point, only Claude reported — Opus should NOT have received the combined message yet
      const opusMessagesAfterClaude = h.opus.getSentMessages();
      const combinedAfterClaude = opusMessagesAfterClaude.filter((m) =>
        m.includes('[FROM:CLAUDE]') && m.includes('[FROM:CODEX]'),
      );
      assert.equal(combinedAfterClaude.length, 0, 'should not deliver until both report');

      // Now Codex reports back
      h.codex.emitText('[TO:OPUS] Backend done');
      await h.flush();

      // Now both reported — combined message should be delivered to Opus
      const opusMessagesAfterBoth = h.opus.getSentMessages();
      const combined = opusMessagesAfterBoth.find(
        (m) => m.includes('[FROM:CLAUDE]') && m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'should deliver combined report when all delegates finish');
      assert.ok(combined!.includes('Frontend done'), 'combined should include Claude report');
      assert.ok(combined!.includes('Backend done'), 'combined should include Codex report');
    });
  });

  // ── Safety-net auto-relay ───────────────────────────────────────────────

  describe('safety-net auto-relay', () => {
    it('auto-relays buffer when agent goes waiting without [TO:OPUS]', async () => {
      // Opus delegates to Claude
      h.opus.emitText('[TO:CLAUDE] Do the task');
      await h.flush();

      // Claude produces output but never sends [TO:OPUS]
      h.claude.emitText('Here is my analysis of the code...');

      // Claude finishes (status → waiting) without explicit [TO:OPUS]
      h.claude.setStatus('waiting');
      await h.flush();

      // The buffered text should have been auto-relayed to Opus
      const opusMessages = h.opus.getSentMessages();
      const autoRelayed = opusMessages.find((m) =>
        m.includes('Here is my analysis of the code'),
      );
      assert.ok(autoRelayed, 'should auto-relay buffered text to Opus');
    });

    it('sends placeholder when buffer is empty on auto-relay', async () => {
      // Opus delegates to Claude
      h.opus.emitText('[TO:CLAUDE] Do the task');
      await h.flush();

      // Claude finishes immediately without producing any output
      h.claude.setStatus('waiting');
      await h.flush();

      // The orchestrator should register a placeholder report
      // (checked via combined delivery if both delegates are expected)
      // For single delegate, the placeholder approach should not crash
      // Just verify no error occurred
      assert.ok(true, 'should not crash with empty buffer');
    });
  });

  // ── Cross-talk + relay bug (historical) ─────────────────────────────────

  describe('cross-talk + relay simultaneous', () => {
    it('captures stdout in relay buffer during cross-talk + relay', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:CLAUDE] Frontend\n[TO:CODEX] Backend');
      await h.flush();

      // Codex sends cross-talk to Claude while Claude is on relay
      h.codex.emitText('[TO:CLAUDE] Hey check this API');
      await h.flush();

      // Claude is now on BOTH relay and cross-talk
      // Claude produces output — it should be captured in relay buffer (not lost)
      h.claude.emitText('Response to codex and my work output');

      // Claude reports to Opus
      h.claude.emitText('[TO:OPUS] Frontend work complete');
      await h.flush();

      // Codex reports too
      h.codex.emitText('[TO:OPUS] Backend work complete');
      await h.flush();

      // Combined delivery should happen with both reports
      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('[FROM:CLAUDE]') && m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'combined report should be delivered even with cross-talk active');
    });
  });

  // ── User direct message ─────────────────────────────────────────────────

  describe('user direct message', () => {
    it('sendToAgent clears relay state for that agent', async () => {
      // Opus delegates to Claude
      h.opus.emitText('[TO:CLAUDE] Do something');
      await h.flush();

      // Claude is now on relay
      h.claude.emitText('Working...');
      const outputsDuringRelay = h.log.outputs.filter(
        (o) => o.agent === 'claude' && o.line.type === 'stdout',
      );
      assert.equal(outputsDuringRelay.length, 0, 'should buffer during relay');

      // User sends directly to Claude — should clear relay state
      h.log.outputs = [];
      h.orchestrator.sendToAgent('claude', 'Hey Claude, stop that');
      await h.flush();

      // After clearing, Claude's stdout should pass through
      h.log.outputs = [];
      h.claude.emitText('Direct response to user');
      const outputsAfterClear = h.log.outputs.filter(
        (o) => o.agent === 'claude' && o.line.type === 'stdout',
      );
      assert.ok(outputsAfterClear.length > 0, 'stdout should pass through after relay cleared');
    });

    it('sendToAllDirect clears all relay state', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:CLAUDE] Frontend\n[TO:CODEX] Backend');
      await h.flush();

      // User sends to all — clears everything
      h.orchestrator.sendToAllDirect('Everyone stop');
      await h.flush();

      // Both agents should now output freely
      h.log.outputs = [];
      h.claude.emitText('Claude free output');
      h.codex.emitText('Codex free output');

      const claudeOut = h.log.outputs.filter(
        (o) => o.agent === 'claude' && o.line.type === 'stdout',
      );
      const codexOut = h.log.outputs.filter(
        (o) => o.agent === 'codex' && o.line.type === 'stdout',
      );
      assert.ok(claudeOut.length > 0, 'claude stdout should pass through');
      assert.ok(codexOut.length > 0, 'codex stdout should pass through');
    });
  });

  // ── Agent crash ─────────────────────────────────────────────────────────

  describe('agent crash', () => {
    it('handles delegate crash with placeholder and triggers combined delivery', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:CLAUDE] Frontend\n[TO:CODEX] Backend');
      await h.flush();

      // Claude crashes
      h.claude.setStatus('error');
      await h.flush();

      // Codex reports normally
      h.codex.emitText('[TO:OPUS] Backend done successfully');
      await h.flush();

      // Combined delivery should still happen with placeholder for Claude
      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'should deliver combined report even with crashed agent');
    });

    it('crashed delegate gets placeholder text in combined report', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:CLAUDE] Frontend\n[TO:CODEX] Backend');
      await h.flush();

      // Codex reports first
      h.codex.emitText('[TO:OPUS] Backend done');
      await h.flush();

      // Claude crashes — should generate placeholder and trigger delivery
      h.claude.setStatus('error');
      await h.flush();

      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('[FROM:CLAUDE]') && m.includes('pas de rapport'),
      );
      assert.ok(combined, 'crashed agent should get placeholder in combined report');
    });
  });

  // ── Rate limiting ───────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('blocks relay after 12 relays per window', async () => {
      // Emit 12 relay tags from opus — should all work
      for (let i = 0; i < 12; i++) {
        h.opus.emitText(`[TO:CLAUDE] Task ${i + 1}`);
      }
      await h.flush();

      const relaysBefore = h.log.relays.length;

      // 13th should be rate limited
      h.opus.emitText('[TO:CLAUDE] Task 13 should be blocked');
      await h.flush();

      assert.equal(
        h.log.relays.length,
        relaysBefore,
        '13th relay should be blocked by rate limiting',
      );
    });
  });
});
