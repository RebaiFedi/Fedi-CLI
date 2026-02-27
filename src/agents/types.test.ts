import test from 'node:test';
import assert from 'node:assert/strict';
import { TO_CLAUDE_PATTERN, TO_CODEX_PATTERN, TO_GEMINI_PATTERN } from './types.js';

test('relay patterns match only standalone directive lines', () => {
  const directToClaude = '  [TO:CLAUDE] endpoint /api/tasks is ready  ';
  const directToCodex = '[TO:CODEX] need POST /api/login with JWT';

  const claudeMatch = directToClaude.match(TO_CLAUDE_PATTERN);
  const codexMatch = directToCodex.match(TO_CODEX_PATTERN);

  assert.ok(claudeMatch);
  assert.ok(codexMatch);
  assert.equal(claudeMatch[1], 'endpoint /api/tasks is ready');
  assert.equal(codexMatch[1], 'need POST /api/login with JWT');
});

test('relay patterns ignore mentions inside normal sentences', () => {
  const mentionToClaude = 'Use [TO:CLAUDE] message format when you need to relay.';
  const mentionToCodex = '- To send a message, write [TO:CODEX] your message here';

  assert.equal(mentionToClaude.match(TO_CLAUDE_PATTERN), null);
  assert.equal(mentionToCodex.match(TO_CODEX_PATTERN), null);
});

test('relay patterns allow empty content (Codex puts content on next line) and require exact casing', () => {
  // Tag alone on a line is valid — content comes from subsequent lines
  const claudeAlone = '[TO:CLAUDE]'.match(TO_CLAUDE_PATTERN);
  assert.ok(claudeAlone, '[TO:CLAUDE] alone should match');
  assert.equal(claudeAlone![1], '', 'captured content should be empty');

  const codexSpaces = '[TO:CODEX]   '.match(TO_CODEX_PATTERN);
  assert.ok(codexSpaces, '[TO:CODEX] with trailing spaces should match');
  assert.equal(codexSpaces![1], '', 'captured content should be empty');

  // Wrong casing should NOT match
  assert.equal('[to:claude] hello'.match(TO_CLAUDE_PATTERN), null);
  assert.equal('[to:codex] hello'.match(TO_CODEX_PATTERN), null);
});

test('TO_GEMINI_PATTERN matches standalone directive lines', () => {
  const directToGemini = '  [TO:GEMINI] lis le fichier src/index.tsx  ';
  const match = directToGemini.match(TO_GEMINI_PATTERN);
  assert.ok(match);
  assert.equal(match[1], 'lis le fichier src/index.tsx');

  // Tag alone on a line is valid
  const geminiAlone = '[TO:GEMINI]'.match(TO_GEMINI_PATTERN);
  assert.ok(geminiAlone, '[TO:GEMINI] alone should match');
  assert.equal(geminiAlone![1], '', 'captured content should be empty');

  // Wrong casing should NOT match
  assert.equal('[to:gemini] hello'.match(TO_GEMINI_PATTERN), null);
});
