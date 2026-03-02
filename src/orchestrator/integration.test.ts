import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestOrchestrator, type TestHarness } from '../test-utils/test-harness.js';

/**
 * Integration tests — verify full relay→delegate→report flow
 * including state transitions, multi-round delegation, live messages,
 * and edge cases not covered by unit/scenario tests.
 */
describe('Integration — relay→delegate→report lifecycle', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = createTestOrchestrator();
    await h.start();
  });

  afterEach(async () => {
    await h.orchestrator.stop();
  });

  // ── Multi-round delegation ──────────────────────────────────────────────

  it('multi-round: Opus delegates round 1, receives reports, then delegates round 2', async () => {
    // Round 1: Opus delegates to Sonnet
    h.opus.emitText('[TO:SONNET] Analyse le composant Header');
    h.opus.setStatus('waiting');
    await h.flush();

    // Sonnet reports
    h.sonnet.emitText('[TO:OPUS] Header: composant fonctionnel, 3 props, pas de bugs');
    h.sonnet.setStatus('waiting');
    await h.flush();

    // Opus receives the report
    const round1Messages = h.opus.getSentMessages();
    const round1Report = round1Messages.find((m) => m.includes('[FROM:SONNET]'));
    assert.ok(round1Report, 'Opus should receive round 1 report from Sonnet');
    assert.ok(round1Report!.includes('Header'), 'round 1 report should contain Header analysis');

    // Round 2: Opus delegates to both based on the first report
    h.opus.clearMessages();
    h.opus.setStatus('running');
    h.opus.emitText(
      '[TO:SONNET] Refactorise Header avec les props manquantes\n[TO:CODEX] Ajoute les routes API pour le header dynamique',
    );
    h.opus.setStatus('waiting');
    await h.flush();

    // Both agents work and report
    h.sonnet.emitText('[TO:OPUS] Header refactorise — 5 props, composant optimise');
    h.sonnet.setStatus('waiting');
    await h.flush();

    h.codex.emitText('[TO:OPUS] Routes API /api/header ajoutees — GET et PUT');
    h.codex.setStatus('waiting');
    await h.flush();

    // Opus should receive combined round 2 report
    const round2Messages = h.opus.getSentMessages();
    const round2Combined = round2Messages.find(
      (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
    );
    assert.ok(round2Combined, 'Opus should receive combined round 2 report');
    assert.ok(round2Combined!.includes('Header refactorise'), 'round 2 should include Sonnet work');
    assert.ok(round2Combined!.includes('Routes API'), 'round 2 should include Codex work');
  });

  // ── Live message during delegation ──────────────────────────────────────

  it('live message reaches working agent during active delegation', async () => {
    // Opus delegates to Sonnet
    h.opus.emitText('[TO:SONNET] Cree la page dashboard');
    h.opus.setStatus('waiting');
    await h.flush();

    // Sonnet is working (running)
    h.sonnet.setStatus('running');

    // User sends a LIVE message to Sonnet while working
    h.orchestrator.sendUserMessageLive('Utilise Tailwind au lieu de CSS modules', 'sonnet');
    await h.flush();

    // Sonnet should receive the urgent message
    const urgentMessages = h.sonnet.getUrgentMessages();
    assert.ok(urgentMessages.length > 0, 'Sonnet should receive urgent LIVE message');
    const liveMsg = urgentMessages.find((m) => m.includes('Tailwind'));
    assert.ok(liveMsg, 'LIVE message content should reach Sonnet');

    // Sonnet finishes and reports
    h.sonnet.emitText('[TO:OPUS] Dashboard cree avec Tailwind CSS');
    h.sonnet.setStatus('waiting');
    await h.flush();

    // Opus should receive the report
    const opusMessages = h.opus.getSentMessages();
    const report = opusMessages.find((m) => m.includes('[FROM:SONNET]'));
    assert.ok(report, 'Opus should still receive report after LIVE message interruption');
    assert.ok(report!.includes('Tailwind'), 'report should reflect the LIVE message instruction');
  });

  // ── Cross-talk coordination flow ────────────────────────────────────────

  it('bidirectional cross-talk: both agents exchange before reporting', async () => {
    // Opus delegates to both
    h.opus.emitText(
      '[TO:SONNET] Cree le formulaire de commande\n[TO:CODEX] Cree l API de commande',
    );
    h.opus.setStatus('waiting');
    await h.flush();

    // Sonnet asks Codex about the API contract
    h.sonnet.emitText('[TO:CODEX] Quel format pour le payload de commande?');
    h.sonnet.setStatus('waiting');
    await h.flush();

    // Codex responds with API spec
    h.codex.emitText('[TO:SONNET] POST /api/orders — {items: [{productId, qty}], address: string}');
    await h.flush();

    // Sonnet asks a follow-up
    h.sonnet.emitText('[TO:CODEX] Et pour la validation? Cote serveur ou client?');
    h.sonnet.setStatus('waiting');
    await h.flush();

    // Codex responds
    h.codex.emitText('[TO:SONNET] Les deux — zod schema partage');
    await h.flush();

    // Both report to Opus
    h.sonnet.emitText('[TO:OPUS] Formulaire cree avec validation zod cote client');
    h.sonnet.setStatus('waiting');
    await h.flush();

    h.codex.emitText('[TO:OPUS] API commandes + validation zod serveur');
    h.codex.setStatus('waiting');
    await h.flush();

    // Opus should receive the combined report
    const opusMessages = h.opus.getSentMessages();
    const combined = opusMessages.find(
      (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
    );
    assert.ok(combined, 'combined report should arrive after bidirectional cross-talk');
    assert.ok(combined!.includes('validation zod'), 'reports should reflect cross-talk decisions');
  });

  // ── Single delegation (no combined report) ──────────────────────────────

  it('single delegation: report delivered directly, no combined delay', async () => {
    // Opus delegates to Codex only
    h.opus.emitText('[TO:CODEX] Mets a jour la config de la base de donnees');
    h.opus.setStatus('waiting');
    await h.flush();

    // Codex works and reports
    h.codex.emitText('[TO:OPUS] Config DB mise a jour — connection pool augmente a 20');
    h.codex.setStatus('waiting');
    await h.flush();

    // Opus should receive Codex's report (single delegation = no combined wait)
    const opusMessages = h.opus.getSentMessages();
    const report = opusMessages.find((m) => m.includes('[FROM:CODEX]'));
    assert.ok(report, 'Opus should receive single agent report');
    assert.ok(report!.includes('connection pool'), 'report content should be preserved');
  });

  // ── Relay callbacks fired ───────────────────────────────────────────────

  it('relay callbacks fire for each relay in the chain', async () => {
    h.log.relays = [];

    // Opus delegates to both
    h.opus.emitText('[TO:SONNET] Tache frontend\n[TO:CODEX] Tache backend');
    h.opus.setStatus('waiting');
    await h.flush();

    // Should have 2 relays: opus→sonnet and opus→codex
    const opusRelays = h.log.relays.filter((r) => r.from === 'opus');
    assert.ok(opusRelays.length >= 2, `expected at least 2 Opus relays, got ${opusRelays.length}`);
    assert.ok(
      opusRelays.some((r) => r.to === 'sonnet'),
      'should have relay from opus to sonnet',
    );
    assert.ok(
      opusRelays.some((r) => r.to === 'codex'),
      'should have relay from opus to codex',
    );

    // Cross-talk: Sonnet→Codex
    h.sonnet.emitText('[TO:CODEX] Question technique');
    h.sonnet.setStatus('waiting');
    await h.flush();

    const crossTalkRelay = h.log.relays.find((r) => r.from === 'sonnet' && r.to === 'codex');
    assert.ok(crossTalkRelay, 'cross-talk relay should fire callback');

    // Reports: both→Opus
    h.codex.emitText('[TO:SONNET] Reponse technique');
    await h.flush();

    h.sonnet.emitText('[TO:OPUS] Rapport frontend');
    h.sonnet.setStatus('waiting');
    await h.flush();

    h.codex.emitText('[TO:OPUS] Rapport backend');
    h.codex.setStatus('waiting');
    await h.flush();

    // At least 5 relays total: 2 delegation + 2 cross-talk + 2 reports
    assert.ok(
      h.log.relays.length >= 5,
      `expected at least 5 total relays in chain, got ${h.log.relays.length}`,
    );
  });

  // ── Agent crash mid-delegation with recovery ────────────────────────────

  it('one agent crashes then recovers for round 2', async () => {
    // Round 1: both agents delegated, Sonnet crashes
    h.opus.emitText('[TO:SONNET] Analyse le CSS\n[TO:CODEX] Analyse les routes');
    h.opus.setStatus('waiting');
    await h.flush();

    h.sonnet.setStatus('error');
    await h.flush();

    h.codex.emitText('[TO:OPUS] Routes analysees — 12 endpoints');
    h.codex.setStatus('waiting');
    await h.flush();

    // Opus receives report (with fallback for Sonnet)
    const round1Msgs = h.opus.getSentMessages();
    const hasCodexReport = round1Msgs.some((m) => m.includes('[FROM:CODEX]'));
    assert.ok(hasCodexReport, 'Opus should receive Codex report in round 1');

    // Round 2: Opus retries with Sonnet (recovered) + Codex
    h.opus.clearMessages();
    h.opus.setStatus('running');

    // Sonnet recovers
    h.sonnet.setStatus('idle');

    h.opus.emitText('[TO:SONNET] Analyse le CSS (retry)\n[TO:CODEX] Implemente les corrections');
    h.opus.setStatus('waiting');
    await h.flush();

    // Both succeed this time
    h.sonnet.emitText('[TO:OPUS] CSS analyse — 3 problemes trouves');
    h.sonnet.setStatus('waiting');
    await h.flush();

    h.codex.emitText('[TO:OPUS] Corrections implementees');
    h.codex.setStatus('waiting');
    await h.flush();

    // Opus should receive combined round 2 report
    const round2Msgs = h.opus.getSentMessages();
    const combined = round2Msgs.find(
      (m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'),
    );
    assert.ok(combined, 'round 2 combined report should arrive after Sonnet recovery');
    assert.ok(combined!.includes('CSS analyse'), 'round 2 should include Sonnet retry result');
  });

  // ── Direct user message to single agent ─────────────────────────────────

  it('direct @agent message bypasses Opus delegation', async () => {
    // User sends directly to Sonnet via @sonnet
    h.orchestrator.sendToAgent('sonnet', 'Montre-moi le composant Header');
    await h.flush();

    // Sonnet should receive the message directly (not through Opus)
    const sonnetMessages = h.sonnet.getSentMessages();
    assert.ok(sonnetMessages.length > 0, 'Sonnet should receive direct message');
    const directMsg = sonnetMessages.find((m) => m.includes('[FROM:USER]'));
    assert.ok(directMsg, 'direct message should be tagged [FROM:USER]');
    assert.ok(directMsg!.includes('Header'), 'direct message content preserved');

    // Opus should NOT receive this message
    const opusMessages = h.opus.getSentMessages();
    const opusGotIt = opusMessages.find((m) => m.includes('Header'));
    assert.equal(opusGotIt, undefined, 'Opus should NOT receive @agent direct message');
  });

  // ── Sequential delegation (round-robin) ─────────────────────────────────

  it('sequential single-agent delegations maintain clean state between rounds', async () => {
    // Round 1: delegate to Codex only
    h.opus.emitText('[TO:CODEX] Cree le schema users');
    h.opus.setStatus('waiting');
    await h.flush();

    h.codex.emitText('[TO:OPUS] Schema users cree avec 5 champs');
    h.codex.setStatus('waiting');
    await h.flush();

    const r1 = h.opus.getSentMessages();
    assert.ok(
      r1.some((m) => m.includes('[FROM:CODEX]')),
      'round 1 Codex report delivered',
    );

    // Round 2: delegate to Sonnet only
    h.opus.clearMessages();
    h.opus.setStatus('running');
    h.opus.emitText('[TO:SONNET] Cree le formulaire users');
    h.opus.setStatus('waiting');
    await h.flush();

    h.sonnet.emitText('[TO:OPUS] Formulaire users cree avec validation');
    h.sonnet.setStatus('waiting');
    await h.flush();

    const r2 = h.opus.getSentMessages();
    assert.ok(
      r2.some((m) => m.includes('[FROM:SONNET]')),
      'round 2 Sonnet report delivered',
    );

    // Round 3: delegate to both
    h.opus.clearMessages();
    h.opus.setStatus('running');
    h.opus.emitText(
      '[TO:SONNET] Connecte le formulaire a l API\n[TO:CODEX] Ajoute les routes CRUD users',
    );
    h.opus.setStatus('waiting');
    await h.flush();

    h.sonnet.emitText('[TO:OPUS] Formulaire connecte a /api/users');
    h.sonnet.setStatus('waiting');
    await h.flush();

    h.codex.emitText('[TO:OPUS] Routes CRUD users ajoutees');
    h.codex.setStatus('waiting');
    await h.flush();

    const r3 = h.opus.getSentMessages();
    const combined = r3.find((m) => m.includes('[FROM:SONNET]') && m.includes('[FROM:CODEX]'));
    assert.ok(combined, 'round 3 combined report delivered after sequential single-agent rounds');
  });

  // ── Pre-tag text emitted to user ────────────────────────────────────────

  it('Opus pre-tag conversational text is shown to user, not swallowed', async () => {
    // Opus emits a block with conversational text BEFORE [TO:*] tags
    // This simulates: "Haha, alright !\n---\n[TO:SONNET] Do work\n[TO:CODEX] Do work"
    h.log.outputs = [];
    h.opus.emitText(
      'Haha, alright ! Let me delegate this.\n[TO:SONNET] Analyse le frontend\n[TO:CODEX] Analyse le backend',
    );
    h.opus.setStatus('waiting');
    await h.flush();

    // The pre-tag text should be visible in the output
    const opusOutputs = h.log.outputs.filter((o) => o.agent === 'opus' && o.line.type === 'stdout');
    const preTagOutput = opusOutputs.find((o) => o.line.text.includes('Haha, alright'));
    assert.ok(preTagOutput, 'pre-tag conversational text should be emitted to the user');

    // The relay should also work
    const sonnetRelay = h.log.relays.find((r) => r.to === 'sonnet');
    assert.ok(sonnetRelay, 'relay to Sonnet should still work');
  });
});
