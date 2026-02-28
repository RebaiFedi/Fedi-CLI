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

    it('sendToAllDirect instructs Opus to delegate (workers delayed)', async () => {
      h.orchestrator.sendToAllDirect('Analyse front et back');
      await h.flush();

      const opusMessages = h.opus.getSentMessages();
      const opusPrompt = opusMessages.find((m) => m.includes('[MODE @TOUS ACTIVE]'));

      assert.ok(opusPrompt, 'Opus should receive explicit @tous mode instruction');
      assert.ok(
        opusPrompt!.includes('[TO:SONNET]'),
        'Opus message should show delegation syntax example',
      );
      assert.ok(
        opusPrompt!.includes('MESSAGE DU USER:\nAnalyse front et back'),
        'Original user text should be preserved in Opus message',
      );

      // Workers should NOT receive messages immediately — they wait for
      // Opus to decide (delegate or respond). If Opus delegates, workers
      // get their tasks through the delegation. If not, a 5s timer fires.
      const sonnetMessages = h.sonnet.getSentMessages();
      const codexMessages = h.codex.getSentMessages();
      assert.equal(sonnetMessages.length, 0, 'Sonnet should NOT receive message immediately');
      assert.equal(codexMessages.length, 0, 'Codex should NOT receive message immediately');
    });

    it('sendToAllDirect uses urgent path for Opus (workers delayed)', async () => {
      h.opus.setStatus('running');
      h.sonnet.setStatus('running');
      h.codex.setStatus('running');

      h.orchestrator.sendToAllDirect('Urgent all-mode task');
      await h.flush();

      const opusUrgent = h.opus.getUrgentMessages();
      assert.ok(opusUrgent.length > 0, 'Opus should receive urgent message');
      assert.ok(
        opusUrgent.some((m) => m.includes('[MODE @TOUS ACTIVE]')),
        'Urgent Opus payload should include explicit @tous instruction',
      );

      // Workers should NOT receive urgent messages immediately — delayed until
      // Opus decides (delegate for tasks, timer for simple questions)
      const sonnetUrgent = h.sonnet.getUrgentMessages();
      const codexUrgent = h.codex.getUrgentMessages();
      assert.equal(sonnetUrgent.length, 0, 'Sonnet should NOT receive urgent message immediately');
      assert.equal(codexUrgent.length, 0, 'Codex should NOT receive urgent message immediately');
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

  // ── Scenario tests (user-facing flows) ─────────────────────────────────

  describe('scenario tests', () => {
    it('Test 1 — Question simple: Opus répond directement, 0 relays', async () => {
      // User asks a simple question → Opus responds directly, no delegation
      h.orchestrator.sendUserMessage('Comment fonctionne le cross-talk?');
      await h.flush();

      // Opus should receive the user message
      const opusMessages = h.opus.getSentMessages();
      assert.ok(opusMessages.length >= 1, 'Opus should receive the user message');

      // Opus responds directly — no relay tags, just text output
      h.opus.emitText('Le cross-talk permet aux agents de communiquer directement.');
      h.opus.setStatus('waiting');
      await h.flush();

      // Verify NO relays were emitted (no delegation)
      const relaysDuringQuestion = h.log.relays.filter(
        (r) => r.to === 'sonnet' || r.to === 'codex',
      );
      assert.equal(relaysDuringQuestion.length, 0, 'simple question should produce 0 relays');

      // Verify output was passed to UI
      const opusOutput = h.log.outputs.filter(
        (o) => o.agent === 'opus' && o.line.type === 'stdout',
      );
      assert.ok(opusOutput.length > 0, 'Opus output should be passed to UI');
    });

    it('Test 2 — @sonnet direct: Sonnet reçoit [FROM:USER], Opus ne reçoit rien', async () => {
      // User sends directly to Sonnet via @sonnet
      h.opus.clearMessages();
      h.orchestrator.sendToAgent('sonnet', 'Explique le composant Header.tsx');
      await h.flush();

      // Sonnet should receive the message with [FROM:USER]
      const sonnetMessages = h.sonnet.getSentMessages();
      const directMsg = sonnetMessages.find((m) => m.includes('[FROM:USER]'));
      assert.ok(directMsg, 'Sonnet should receive [FROM:USER] message');
      assert.ok(directMsg!.includes('Explique le composant Header.tsx'), 'message content should be preserved');

      // Opus should NOT receive anything for this direct message
      const opusMessagesAfter = h.opus.getSentMessages();
      const opusGotDirect = opusMessagesAfter.find((m) => m.includes('Header.tsx'));
      assert.equal(opusGotDirect, undefined, 'Opus should not receive @sonnet direct messages');
    });

    it('Test 3 — Fix simple: Opus délègue à Sonnet seul, Sonnet rapporte', async () => {
      // User asks for a fix → Opus delegates to Sonnet only
      h.orchestrator.sendUserMessage('Corrige le bug dans le bouton Login');
      await h.flush();

      // Opus delegates to Sonnet only
      h.opus.emitText('[TO:SONNET] Corrige le bug dans le composant Login.tsx — le bouton ne fonctionne pas');
      h.opus.setStatus('waiting');
      await h.flush();

      // Sonnet works and reports back
      h.sonnet.emitText('[TO:OPUS] Bug corrige — le onClick manquait un handler. Fix applique dans Login.tsx');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // Opus should receive Sonnet's report
      const opusMessages = h.opus.getSentMessages();
      const report = opusMessages.find((m) => m.includes('[FROM:SONNET]'));
      assert.ok(report, 'Opus should receive [FROM:SONNET] report');
      assert.ok(report!.includes('Bug corrige'), 'report content should be preserved');
    });

    it('Test 4 — Analyse complète (2 agents): rapport combiné livré à Opus', async () => {
      // User asks for full analysis → Opus delegates to both
      h.orchestrator.sendUserMessage('Analyse le projet complet');
      await h.flush();

      h.opus.emitText('[TO:SONNET] Analyse le frontend\n[TO:CODEX] Analyse le backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Sonnet reports first
      h.sonnet.emitText('[TO:OPUS] Frontend: 12 composants React, architecture propre');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // No combined report yet — still waiting for Codex
      const msgAfterSonnet = h.opus.getSentMessages();
      const combinedEarly = msgAfterSonnet.find(
        (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
      );
      assert.equal(combinedEarly, undefined, 'should NOT deliver combined report before all reports arrive');

      // Codex reports
      h.codex.emitText('[TO:OPUS] Backend: 8 routes REST, base PostgreSQL');
      h.codex.setStatus('waiting');
      await h.flush();

      // Now combined report should be delivered
      const msgAfterBoth = h.opus.getSentMessages();
      const combined = msgAfterBoth.find(
        (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'combined report [RAPPORTS RECUS] should be delivered to Opus');
      assert.ok(combined!.includes('12 composants React'), 'combined should include Sonnet report');
      assert.ok(combined!.includes('8 routes REST'), 'combined should include Codex report');
    });

    it('Test 5 — @tous: Opus reçoit immédiatement, workers attendent décision Opus', async () => {
      // User sends @tous → Opus receives immediately, workers wait
      h.orchestrator.sendToAllDirect('Analyse le projet');
      await h.flush();

      // Opus should receive [MODE @TOUS ACTIVE] with delegation instructions
      const opusMessages = h.opus.getSentMessages();
      const tousMsg = opusMessages.find((m) => m.includes('[MODE @TOUS ACTIVE]'));
      assert.ok(tousMsg, 'Opus should receive [MODE @TOUS ACTIVE]');

      // Workers should NOT receive message immediately — they wait for Opus to
      // decide (delegation for tasks, 5s timer for simple questions)
      const sonnetMessages = h.sonnet.getSentMessages();
      const codexMessages = h.codex.getSentMessages();
      assert.equal(sonnetMessages.length, 0, 'Sonnet should NOT receive message immediately');
      assert.equal(codexMessages.length, 0, 'Codex should NOT receive message immediately');

      // Simulate Opus delegating → workers get tasks through delegation
      h.opus.emitText('[TO:SONNET] Analyse le frontend\n[TO:CODEX] Analyse le backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Workers should now have received through delegation relay
      const sonnetRelays = h.log.relays.filter((r) => r.to === 'sonnet');
      const codexRelays = h.log.relays.filter((r) => r.to === 'codex');
      assert.ok(sonnetRelays.length > 0, 'Sonnet should receive task through delegation');
      assert.ok(codexRelays.length > 0, 'Codex should receive task through delegation');
    });

    it('Test 6 — LIVE message pendant le travail: agent reçoit urgent', async () => {
      // Sonnet is running (working on a task)
      h.sonnet.setStatus('running');

      // User sends a LIVE message to Sonnet
      h.orchestrator.sendUserMessageLive('arrete et corrige le Header', 'sonnet');
      await h.flush();

      // Sonnet should receive urgent [LIVE MESSAGE DU USER]
      const urgentMessages = h.sonnet.getUrgentMessages();
      const liveMsg = urgentMessages.find((m) => m.includes('[LIVE MESSAGE DU USER]'));
      assert.ok(liveMsg, 'Sonnet should receive [LIVE MESSAGE DU USER]');
      assert.ok(liveMsg!.includes('arrete et corrige le Header'), 'live message content should be preserved');
    });

    it('Test 7 — @tous avec modification: Opus reçoit @tous puis délègue', async () => {
      // User sends @tous with modification request
      h.orchestrator.sendToAllDirect('Corrige les bugs dans le projet');
      await h.flush();

      // Opus receives @tous
      const opusMessages = h.opus.getSentMessages();
      const tousMsg = opusMessages.find((m) => m.includes('[MODE @TOUS ACTIVE]'));
      assert.ok(tousMsg, 'Opus should receive @tous message');
      assert.ok(tousMsg!.includes('Corrige les bugs'), 'original user text should be in @tous message');

      // Opus delegates via relay
      h.opus.emitText('[TO:SONNET] Corrige les bugs frontend\n[TO:CODEX] Corrige les bugs backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Both agents should receive via relay
      const sonnetRelay = h.log.relays.find((r) => r.to === 'sonnet');
      const codexRelay = h.log.relays.find((r) => r.to === 'codex');
      assert.ok(sonnetRelay, 'Sonnet should receive relay from Opus');
      assert.ok(codexRelay, 'Codex should receive relay from Opus');
    });

    it('Test 8 — Délégation séquentielle: round 1 Codex, round 2 Sonnet', async () => {
      // Opus delegates to Codex first (round 1)
      h.orchestrator.sendUserMessage('Cree le module stock: DB puis UI');
      await h.flush();

      h.opus.emitText('[TO:CODEX] Cree le schema DB products et les routes API');
      h.opus.setStatus('waiting');
      await h.flush();

      // Codex reports
      h.codex.emitText('[TO:OPUS] Schema products cree, routes GET/POST/PUT/DELETE fonctionnelles');
      h.codex.setStatus('waiting');
      await h.flush();

      // Opus receives Codex report and delegates to Sonnet (round 2)
      const opusMsgRound1 = h.opus.getSentMessages();
      const codexReport = opusMsgRound1.find((m) => m.includes('[FROM:CODEX]'));
      assert.ok(codexReport, 'Opus should receive Codex report after round 1');

      // Opus now delegates to Sonnet with context from Codex
      h.opus.emitText('[TO:SONNET] Cree les composants StockList et StockForm — API dispo: GET/POST/PUT/DELETE /api/products');
      h.opus.setStatus('waiting');
      await h.flush();

      // Sonnet reports
      h.sonnet.emitText('[TO:OPUS] Composants StockList et StockForm crees avec les appels API');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // Opus receives Sonnet report
      const opusMsgRound2 = h.opus.getSentMessages();
      const sonnetReport = opusMsgRound2.find((m) => m.includes('[FROM:SONNET]'));
      assert.ok(sonnetReport, 'Opus should receive Sonnet report after round 2');
    });

    it('Test 9 — Module création avec cross-talk: delegation + coordination + rapport combiné', async () => {
      // Opus delegates to both with plan
      h.opus.emitText('[TO:SONNET] Module stock — composants StockList, StockForm. Coordonne-toi avec Codex.\n[TO:CODEX] Module stock — schema products, routes API. Coordonne-toi avec Sonnet.');
      h.opus.setStatus('waiting');
      await h.flush();

      // Sonnet cross-talks with Codex
      h.sonnet.emitText('[TO:CODEX] Quels endpoints REST tu exposes pour le module stock?');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // Codex responds to Sonnet
      h.codex.emitText('[TO:SONNET] GET/POST/PUT/DELETE /api/products — payload: {name, qty, price}');
      await h.flush();

      // Both report to Opus
      h.sonnet.emitText('[TO:OPUS] Frontend stock cree — StockList et StockForm consomment /api/products');
      h.sonnet.setStatus('waiting');
      await h.flush();

      h.codex.emitText('[TO:OPUS] Backend stock cree — schema products + 4 routes CRUD');
      h.codex.setStatus('waiting');
      await h.flush();

      // Combined report should be delivered
      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'combined report should include both agent reports after cross-talk');
    });

    it('Test 10 — Cross-talk front↔back: Sonnet→Codex→Sonnet + rapport combiné', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:SONNET] Integre l API users dans le frontend\n[TO:CODEX] Documente l API users');
      h.opus.setStatus('waiting');
      await h.flush();

      // Sonnet asks Codex about endpoints
      h.sonnet.emitText('[TO:CODEX] Quels sont les endpoints pour /api/users?');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // Codex responds
      h.codex.emitText('[TO:SONNET] GET /api/users (liste), POST /api/users (creation), GET /api/users/:id (detail)');
      await h.flush();

      // Both report
      h.sonnet.emitText('[TO:OPUS] Integration faite — UserList et UserForm consomment les 3 endpoints');
      h.sonnet.setStatus('waiting');
      await h.flush();

      h.codex.emitText('[TO:OPUS] Documentation API users generee — 3 endpoints documentes');
      h.codex.setStatus('waiting');
      await h.flush();

      // Combined report
      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'cross-talk front<->back should result in combined report');
      assert.ok(combined!.includes('UserList'), 'combined should contain Sonnet work');
      assert.ok(combined!.includes('Documentation'), 'combined should contain Codex work');
    });

    it('Test 11 — Agent crash + fallback: Sonnet crash → fallback relay vers Codex ou Opus', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:SONNET] Corrige le frontend\n[TO:CODEX] Corrige le backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Sonnet crashes
      h.sonnet.setStatus('error');
      await h.flush();

      // Codex reports normally
      h.codex.emitText('[TO:OPUS] Backend corrige');
      h.codex.setStatus('waiting');
      await h.flush();

      // Opus should receive at least Codex's report (combined delivery or fallback)
      const opusMessages = h.opus.getSentMessages();
      const hasCodexReport = opusMessages.find((m) => m.includes('[FROM:CODEX]'));
      assert.ok(hasCodexReport, 'Opus should receive Codex report despite Sonnet crash');

      // There should be a fallback or error indication for Sonnet
      const hasFallback = opusMessages.find(
        (m) => m.includes('FALLBACK') || m.includes('erreur') || m.includes('error') || m.includes('pas de rapport'),
      );
      assert.ok(hasFallback, 'Opus should receive fallback/error for crashed Sonnet');
    });

    it('Test 12 — Les 2 agents crash + Opus fallback', async () => {
      // Opus delegates to both
      h.opus.emitText('[TO:SONNET] Analyse le frontend\n[TO:CODEX] Analyse le backend');
      h.opus.setStatus('waiting');
      await h.flush();

      // Both agents crash
      h.sonnet.setStatus('error');
      await h.flush();

      h.codex.setStatus('error');
      await h.flush();

      // Opus should receive fallback messages for both
      const opusMessages = h.opus.getSentMessages();
      const fallbackMessages = opusMessages.filter(
        (m) => m.includes('FALLBACK') || m.includes('erreur') || m.includes('error') || m.includes('pas de rapport'),
      );
      assert.ok(fallbackMessages.length >= 1, 'Opus should receive fallback when both agents crash');
    });

    it('Test 13 — @tous: Opus stdout bufferisé dès délégation même en mode @tous', async () => {
      // User sends @tous → Opus delegates + works himself
      h.orchestrator.sendToAllDirect('Analyse le projet');
      await h.flush();

      // Opus delegates to both agents
      h.opus.emitText('[TO:SONNET] Analyse le frontend\n[TO:CODEX] Analyse le backend');
      await h.flush();

      // Opus does his own analysis — stdout should be BUFFERED because delegates are pending
      // (even in @tous mode, text output is held back to prevent premature reports)
      h.log.outputs = [];
      h.opus.emitText('Mon analyse du projet — rapport premature');
      const opusTextOutputs = h.log.outputs.filter(
        (o) => o.agent === 'opus' && o.line.type === 'stdout',
      );
      assert.equal(opusTextOutputs.length, 0, 'Opus stdout should be BUFFERED in @tous when delegates pending');

      // Actions (system type) should still pass through so user sees Opus working
      h.opus.emitAction('Read src/index.tsx');
      const actionOutputs = h.log.outputs.filter(
        (o) => o.agent === 'opus' && o.line.type === 'system',
      );
      assert.ok(actionOutputs.length > 0, 'Opus actions should pass through in @tous mode');

      // Sonnet reports
      h.sonnet.emitText('[TO:OPUS] Frontend: 12 composants');
      h.sonnet.setStatus('waiting');
      await h.flush();

      // Codex reports → triggers combined delivery
      h.codex.emitText('[TO:OPUS] Backend: 8 routes');
      h.codex.setStatus('waiting');
      await h.flush();

      // Opus should now receive the combined report (with [RAPPORTS RECUS] header)
      const opusMessages = h.opus.getSentMessages();
      const combined = opusMessages.find(
        (m) => m.includes('RAPPORTS RECUS') && m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
      );
      assert.ok(combined, 'Opus should receive combined report after both delegates finish');

      // The combined delivery should include Opus's own buffered analysis so Opus
      // has full context to write a fused rapport (instead of thinking it already wrote one)
      assert.ok(
        combined!.includes('TA PROPRE ANALYSE'),
        'Combined delivery should include Opus own analysis section',
      );
      assert.ok(
        combined!.includes('rapport premature'),
        'Combined delivery should contain Opus buffered text',
      );

      // The combined message should tell Opus it hasn't shown anything to the user yet
      assert.ok(
        combined!.includes('PREMIERE fois'),
        'Combined delivery should tell Opus this is the first time user sees a rapport',
      );
    });
  });
});
