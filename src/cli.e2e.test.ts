import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '../bin/fedi.js');

/**
 * E2E CLI smoke tests — run the real binary and verify outputs.
 * These test the actual CLI entry point, not mocks.
 */
describe('CLI E2E', () => {
  it('--help exits 0 and prints usage', () => {
    const output = execFileSync('node', [CLI_PATH, '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    assert.match(output, /Fedi CLI/);
    assert.match(output, /USAGE/);
    assert.match(output, /--help/);
    assert.match(output, /--sessions/);
  });

  it('--version exits 0 and prints version', () => {
    const output = execFileSync('node', [CLI_PATH, '--version'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    assert.match(output, /^fedi-cli v\d+\.\d+\.\d+/);
  });

  it('-h is an alias for --help', () => {
    const output = execFileSync('node', [CLI_PATH, '-h'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    assert.match(output, /Fedi CLI/);
    assert.match(output, /USAGE/);
  });

  it('-v is an alias for --version', () => {
    const output = execFileSync('node', [CLI_PATH, '-v'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    assert.match(output, /^fedi-cli v\d+\.\d+\.\d+/);
  });

  it('--sessions exits 0 (empty list is ok)', () => {
    // Run in /tmp so no sessions directory exists — should not crash
    const output = execFileSync('node', [CLI_PATH, '--sessions'], {
      encoding: 'utf-8',
      timeout: 10_000,
      cwd: '/tmp',
    });
    // Should either list sessions or show "no sessions" message
    assert.ok(typeof output === 'string');
  });
});
