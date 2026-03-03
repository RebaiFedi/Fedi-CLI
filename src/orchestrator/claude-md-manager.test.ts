import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureClaudeMd, ensureAgentsMd } from './claude-md-manager.js';

const TEST_DIR = '/tmp/fedi-claude-md-test';

describe('claude-md-manager', () => {
  // Clean test dir before each test
  function setup() {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  }

  it('creates CLAUDE.md in project directory', () => {
    setup();
    ensureClaudeMd(TEST_DIR);
    const path = join(TEST_DIR, 'CLAUDE.md');
    assert.ok(existsSync(path), 'CLAUDE.md should be created');
  });

  it('CLAUDE.md contains the fedi-cli-managed marker', () => {
    setup();
    ensureClaudeMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('<!-- fedi-cli-managed -->'), 'Should contain marker');
  });

  it('CLAUDE.md contains Opus rules', () => {
    setup();
    ensureClaudeMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('OPUS'), 'Should contain Opus rules');
    assert.ok(content.includes('Directeur'), 'Should mention Opus role');
  });

  it('CLAUDE.md contains Sonnet rules', () => {
    setup();
    ensureClaudeMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('SONNET'), 'Should contain Sonnet rules');
    assert.ok(content.includes('frontend'), 'Should mention Sonnet specialty');
  });

  it('CLAUDE.md contains Codex rules', () => {
    setup();
    ensureClaudeMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('CODEX'), 'Should contain Codex rules');
    assert.ok(content.includes('backend'), 'Should mention Codex specialty');
  });

  it('CLAUDE.md contains code quality standards', () => {
    setup();
    ensureClaudeMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('800'), 'Should contain 800 line limit');
    assert.ok(content.includes('QUALITE'), 'Should contain quality section');
  });

  it('does not overwrite user-managed CLAUDE.md', () => {
    setup();
    const userContent = '# My Custom CLAUDE.md\nDo not overwrite me.';
    writeFileSync(join(TEST_DIR, 'CLAUDE.md'), userContent, 'utf-8');
    ensureClaudeMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.equal(content, userContent, 'User-managed CLAUDE.md should not be overwritten');
  });

  it('overwrites fedi-managed CLAUDE.md when content changes', () => {
    setup();
    const oldContent = '<!-- fedi-cli-managed -->\nOld content';
    writeFileSync(join(TEST_DIR, 'CLAUDE.md'), oldContent, 'utf-8');
    ensureClaudeMd(TEST_DIR);
    const newContent = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.ok(newContent.includes('<!-- fedi-cli-managed -->'), 'Should still have marker');
    assert.ok(newContent !== oldContent, 'Content should be updated');
  });

  it('skips write when content is identical', () => {
    setup();
    ensureClaudeMd(TEST_DIR);
    const content1 = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    // Call again — should be a no-op
    ensureClaudeMd(TEST_DIR);
    const content2 = readFileSync(join(TEST_DIR, 'CLAUDE.md'), 'utf-8');
    assert.equal(content1, content2, 'Content should be identical');
  });
});

describe('ensureAgentsMd', () => {
  function setup() {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  }

  it('creates AGENTS.md and returns true', () => {
    setup();
    const result = ensureAgentsMd(TEST_DIR);
    assert.equal(result, true);
    assert.ok(existsSync(join(TEST_DIR, 'AGENTS.md')));
  });

  it('AGENTS.md contains fedi-cli-managed:agents marker', () => {
    setup();
    ensureAgentsMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    assert.ok(content.includes('<!-- fedi-cli-managed:agents -->'));
  });

  it('AGENTS.md contains Codex system prompt', () => {
    setup();
    ensureAgentsMd(TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    assert.ok(content.includes('Codex'), 'Should contain Codex prompt');
    assert.ok(content.includes('backend'), 'Should mention backend role');
  });

  it('returns false for user-managed AGENTS.md', () => {
    setup();
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# My custom agents', 'utf-8');
    const result = ensureAgentsMd(TEST_DIR);
    assert.equal(result, false);
    const content = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    assert.equal(content, '# My custom agents', 'Should not be overwritten');
  });

  it('returns true and updates fedi-managed AGENTS.md', () => {
    setup();
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), '<!-- fedi-cli-managed:agents -->\nOld', 'utf-8');
    const result = ensureAgentsMd(TEST_DIR);
    assert.equal(result, true);
    const content = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    assert.ok(content.includes('Codex'), 'Should contain updated Codex prompt');
  });

  it('returns true when content is already up-to-date', () => {
    setup();
    ensureAgentsMd(TEST_DIR);
    const result = ensureAgentsMd(TEST_DIR);
    assert.equal(result, true);
  });
});
