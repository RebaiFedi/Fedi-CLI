import test from 'node:test';
import assert from 'node:assert/strict';
import { TO_CLAUDE_PATTERN, TO_CODEX_PATTERN } from './types.js';

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

test('relay patterns require non-empty content and exact tag casing', () => {
  assert.equal('[TO:CLAUDE]'.match(TO_CLAUDE_PATTERN), null);
  assert.equal('[TO:CODEX]   '.match(TO_CODEX_PATTERN), null);
  assert.equal('[to:claude] hello'.match(TO_CLAUDE_PATTERN), null);
  assert.equal('[to:codex] hello'.match(TO_CODEX_PATTERN), null);
});
