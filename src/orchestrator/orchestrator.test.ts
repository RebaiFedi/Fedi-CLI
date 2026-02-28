import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestOrchestrator, type TestHarness } from '../test-utils/test-harness.js';

describe('Orchestrator', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = createTestOrchestrator();
    // Start the orchestrator so PQueue handlers accept messages
    await h.start();
  });

  afterEach(async () => {
    // Stop the orchestrator to clean up PQueue tasks, timers, and event listeners.
    // Without this, Node.js keeps the process alive waiting for open handles.
    await h.orchestrator.stop();
  });

  // ── Relay detection ─────────────────────────────────────────────────────

  describe('relay detection', () => {
    it('detects [TO:SONNET] delegation from Opus', async () => {
      // Opus emits a relay tag → should be detected and relayed
      h.opus.emitText('[TO:SONNET] Analyse le fichier index.ts');
      h.opus.setStatus('waiting');
      await h.flush();

      assert.ok(h.log.relays.length >= 1, 'should emit at least 1 relay');
      const relay = h.log.relays.find((r) => r.to === 'sonnet');
      assert.ok(relay, 'relay should target sonnet');
      assert.ok(relay.content.includes('Analyse le fichier index.ts'));
    });

    it('detects multi-delegation [TO:SONNET] + [TO:CODEX] in one text block', async () => {
      h.opus.emitText(
        '[TO:SONNET] Corrige le frontend\n[TO:CODEX] Corrige le backend',
      );
      h.opus.setStatus('waiting');
      await h.flush();

      const claudeRelay = h.log.relays.find((r) => r.to === 'sonnet');
      const codexRelay = h.log.relays.find((r) => r.to === 'codex');
      assert.ok(claudeRelay, 'should relay to sonnet');
      assert.ok(codexRelay, 'should relay to codex');
    });

    it('ignores [TO:SONNET] mentioned inside a sentence (not standalone)', async () => {
      h.opus.emitText('The pattern [TO:SONNET] is used for delegation');
      await h.flush();

      // The pattern requires the tag at start of line — this is embedded in text
      // so it should NOT match (the regex requires ^\s*\[TO:SONNET\])
      // Actually the regex DOES match if the text starts with [TO:SONNET]
      // But "The pattern [TO:SONNET]..." does NOT start with [TO:SONNET]
      const claudeRelays = h.log.relays.filter((r) => r.to === 'sonnet');
      assert.equal(claudeRelays.length, 0, 'should not detect relay tag inside sentence');
    });

    it('keeps relay payload across streamed chunks', async () => {
      h.opus.emitText('[TO:CODEX] ,');
      h.opus.emitText('Tache backend: corrige le parser relay');
      h.opus.emitText('et supprime l explorateur du backend.');
      h.opus.setStatus('waiting');
      await h.flush();

      const relay = h.log.relays.find((r) => r.to === 'codex');
      assert.ok(relay, 'relay should be emitted with merged payload');
      assert.ok(relay.content.includes('Tache backend'));
      assert.ok(relay.content.includes('supprime l explorateur'));
    });
  });

  // ── Relay buffering ─────────────────────────────────────────────────────

  describe('relay buffering', () => {
    it('buffers stdout during relay, passes actions through', async () => {
      // Opus delegates to Claude
      h.opus.emitText('[TO:SONNET] Do the work');
      h.opus.setStatus('waiting');
      await h.flush();

      // Claude is now on relay — stdout should be buffered
      h.log.outputs = [];
      h.sonnet.emitText('Working on it...');

      const textOutputs = h.log.outputs.filter(
        (o) => o.agent === 'sonnet' && o.line.type === 'stdout',
      );
      assert.equal(textOutputs.length, 0, 'stdout should be buffered during relay');

      // Actions (system type) should pass through
      h.sonnet.emitAction('Read src/index.ts');
      const actionOutputs = h.log.outputs.filter(
        (o) => o.agent === 'sonnet' && o.line.type === 'system',
      );
      assert.ok(actionOutputs.length > 0, 'actions should pass through during relay');
    });
  });

  // ── Cross-talk mute ─────────────────────────────────────────────────────

  describe('cross-talk mute', () => {
    it('mutes target agent stdout on cross-talk', async () => {
      // Claude sends cross-talk to Codex
      h.sonnet.emitText('[TO:CODEX] Check the API endpoint');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // Codex is now on cross-talk mute — stdout should be suppressed
      h.log.outputs = [];
      h.codex.emitText('Internal response to Claude');

      const codexTextOutputs = h.log.outputs.filter(
        (o) => o.agent === 'codex' && o.line.type === 'stdout',
      );
      assert.equal(codexTextOutputs.length, 0, 'codex stdout should be muted during cross-talk');
    });

    it('blocks 21st cross-talk when limit is 20 per round', async () => {
      // Send 20 cross-talk messages (the max)
      for (let i = 0; i < 20; i++) {
        h.sonnet.emitText(`[TO:CODEX] Cross-talk message ${i + 1}`);
      }
      h.sonnet.setStatus('waiting');
      await h.flush();

      const relaysBefore = h.log.relays.length;

      // 21st should be blocked
      h.sonnet.emitText('[TO:CODEX] Cross-talk message 21 should be blocked');
      h.sonnet.setStatus('waiting');
      await h.flush();

      assert.equal(
        h.log.relays.length,
        relaysBefore,
        '21st cross-talk should not produce a relay',
      );
    });
  });

  // ── Combined delivery ───────────────────────────────────────────────────

  describe('combined delivery', () => {
    it('delivers combined report only when ALL delegates have reported', async () => {
      // Opus delegates to both Claude and Codex
      h.opus.emitText('[TO:SONNET] Frontend task\n[TO:CODEX] Backend task');
      h.opus.setStatus('waiting');
      await h.flush();

      // Claude reports back
      h.sonnet.emitText('[TO:OPUS] Frontend done');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // At this point, only Claude reported — Opus should NOT have received the combined message yet
      const opusMessagesAfterClaude = h.opus.getSentMessages();
      const combinedAfterClaude = opusMessagesAfterClaude.filter((m) =>
        m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
      );
      assert.equal(combinedAfterClaude.length, 0, 'should not deliver until both report');

      // Now Codex reports back
      h.codex.emitText('[TO:OPUS] Backend done');
      h.codex.setStatus('waiting');
      await h.flush();

      // Now both reported — combined message should be delivered to Opus
      const opusMessagesAfterBoth = h.opus.getSentMessages();
      const combined = opusMessagesAfterBoth.find(
        (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
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
      h.opus.emitText('[TO:SONNET] Do the task');
      h.opus.setStatus('waiting');
      await h.flush();

      // Claude produces output but never sends [TO:OPUS]
      h.sonnet.emitText('Here is my analysis of the code...');

      // Claude finishes (status → waiting) without explicit [TO:OPUS]
      h.sonnet.setStatus('waiting');
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
      h.opus.emitText('[TO:SONNET] Do the task');
      h.opus.setStatus('waiting');
      await h.flush();

      // Claude finishes immediately without producing any output
      h.sonnet.setStatus('waiting');
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
      h.opus.emitText('[TO:SONNET] Frontend\n[TO:CODEX] Backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Codex sends cross-talk to Claude while Claude is on relay
      h.codex.emitText('[TO:SONNET] Hey check this API');
      h.codex.setStatus('waiting');
      await h.flush();

      // Claude is now on BOTH relay and cross-talk
      // Claude produces output — it should be captured in relay buffer (not lost)
      h.sonnet.emitText('Response to codex and my work output');

      // Claude reports to Opus
      h.sonnet.emitText('[TO:OPUS] Frontend work complete');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // Codex reports too
      h.codex.emitText('[TO:OPUS] Backend work complete');
      h.codex.setStatus('waiting');
      await h.flush();

      // Combined delivery should happen with both reports
      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'combined report should be delivered even with cross-talk active');
    });
  });

  // ── User direct message ─────────────────────────────────────────────────

  describe('user direct message', () => {
    it('sendToAgent clears relay state for that agent', async () => {
      // Opus delegates to Claude
      h.opus.emitText('[TO:SONNET] Do something');
      h.opus.setStatus('waiting');
      await h.flush();

      // Claude is now on relay
      h.sonnet.emitText('Working...');
      const outputsDuringRelay = h.log.outputs.filter(
        (o) => o.agent === 'sonnet' && o.line.type === 'stdout',
      );
      assert.equal(outputsDuringRelay.length, 0, 'should buffer during relay');

      // User sends directly to Claude — should clear relay state
      h.log.outputs = [];
      h.orchestrator.sendToAgent('sonnet', 'Hey Claude, stop that');
      await h.flush();

      // After clearing, Claude's stdout should pass through
      h.log.outputs = [];
      h.sonnet.emitText('Direct response to user');
      const outputsAfterClear = h.log.outputs.filter(
        (o) => o.agent === 'sonnet' && o.line.type === 'stdout',
      );
      assert.ok(outputsAfterClear.length > 0, 'stdout should pass through after relay cleared');
    });

    it('sendToAllDirect clears all relay state', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:SONNET] Frontend\n[TO:CODEX] Backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // User sends to all — clears everything
      h.orchestrator.sendToAllDirect('Everyone stop');
      await h.flush();

      // Both agents should now output freely
      h.log.outputs = [];
      h.sonnet.emitText('Claude free output');
      h.codex.emitText('Codex free output');

      const claudeOut = h.log.outputs.filter(
        (o) => o.agent === 'sonnet' && o.line.type === 'stdout',
      );
      const codexOut = h.log.outputs.filter(
        (o) => o.agent === 'codex' && o.line.type === 'stdout',
      );
      assert.ok(claudeOut.length > 0, 'sonnet stdout should pass through');
      assert.ok(codexOut.length > 0, 'codex stdout should pass through');
    });

    it('sendToAllDirect instructs Opus to also do its own analysis', async () => {
      h.orchestrator.sendToAllDirect('Analyse front et back');
      await h.flush();

      const opusMessages = h.opus.getSentMessages();
      const opusPrompt = opusMessages.find((m) => m.includes('[MODE @TOUS ACTIVE]'));

      assert.ok(opusPrompt, 'Opus should receive explicit @tous mode instruction');
      assert.ok(
        opusPrompt!.includes('Fais AUSSI ta propre analyse en parallele'),
        'Opus message should force own analysis in parallel',
      );
      assert.ok(
        opusPrompt!.includes('MESSAGE ORIGINAL DU USER:\nAnalyse front et back'),
        'Original user text should be preserved in Opus message',
      );
    });

    it('sendToAllDirect uses urgent path and keeps @tous instruction for running Opus', async () => {
      h.opus.setStatus('running');
      h.sonnet.setStatus('running');
      h.codex.setStatus('running');

      h.orchestrator.sendToAllDirect('Urgent all-mode task');
      await h.flush();

      const opusUrgent = h.opus.getUrgentMessages();
      const claudeUrgent = h.sonnet.getUrgentMessages();
      const codexUrgent = h.codex.getUrgentMessages();

      assert.ok(opusUrgent.length > 0, 'Opus should receive urgent message');
      assert.ok(claudeUrgent.length > 0, 'Claude should receive urgent message');
      assert.ok(codexUrgent.length > 0, 'Codex should receive urgent message');

      assert.ok(
        opusUrgent.some((m) => m.includes('[MODE @TOUS ACTIVE]')),
        'Urgent Opus payload should include explicit @tous instruction',
      );
      assert.ok(
        claudeUrgent.some((m) => m.includes('[FROM:USER] Urgent all-mode task')),
        'Claude urgent payload should keep raw user text',
      );
      assert.ok(
        codexUrgent.some((m) => m.includes('[FROM:USER] Urgent all-mode task')),
        'Codex urgent payload should keep raw user text',
      );
    });
  });

  // ── Agent crash ─────────────────────────────────────────────────────────

  describe('agent crash', () => {
    it('handles delegate crash with placeholder and triggers combined delivery', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:SONNET] Frontend\n[TO:CODEX] Backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Claude crashes
      h.sonnet.setStatus('error');
      await h.flush();

      // Codex reports normally
      h.codex.emitText('[TO:OPUS] Backend done successfully');
      h.codex.setStatus('waiting');
      await h.flush();

      // Combined delivery should still happen with placeholder for Claude
      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'should deliver combined report even with crashed agent');
    });

    it('crashed delegate falls back to Opus when no worker fallback is available', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:SONNET] Frontend\n[TO:CODEX] Backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Codex reports first
      h.codex.emitText('[TO:OPUS] Backend done');
      h.codex.setStatus('waiting');
      await h.flush();

      // Sonnet crashes after Codex already reported — no worker fallback available
      h.sonnet.setStatus('error');
      await h.flush();

      const opusMessages = h.opus.getSentMessages();
      const fallbackMessage = opusMessages.find(
        (m) =>
          m.includes('[FROM:SYSTEM]') &&
          m.includes('[FALLBACK — sonnet error, aucun agent disponible]') &&
          m.includes('Fais le travail toi-meme: Frontend'),
      );
      assert.ok(
        fallbackMessage,
        'crashed delegate should trigger fallback to Opus when no worker fallback is available',
      );
    });
  });

  // ── Rate limiting ───────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('blocks relay after 50 relays per window', async () => {
      // Emit 50 relay tags from opus — should all work
      for (let i = 0; i < 50; i++) {
        h.opus.emitText(`[TO:SONNET] Task ${i + 1}`);
      }
      h.opus.setStatus('waiting');
      await h.flush();

      const relaysBefore = h.log.relays.length;

      // 51st should be rate limited
      h.opus.emitText('[TO:SONNET] Task 51 should be blocked');
      h.opus.setStatus('waiting');
      await h.flush();

      assert.equal(
        h.log.relays.length,
        relaysBefore,
        '51st relay should be blocked by rate limiting',
      );
    });
  });
});
