import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '../bin/fedi.js');

/**
 * Run the CLI as a child process and return { stdout, stderr, code }.
 * Uses async execFile (not execFileSync) so it works in sandboxed environments
 * where spawnSync may be blocked.
 */
function runCli(
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [CLI_PATH, ...args],
      {
        encoding: 'utf-8',
        timeout: 10_000,
        cwd: options?.cwd,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: error ? ((error as NodeJS.ErrnoException & { status?: number }).status ?? 1) : 0,
        });
      },
    );
  });
}

/**
 * E2E CLI smoke tests — run the real binary and verify outputs.
 * These test the actual CLI entry point, not mocks.
 */
describe('CLI E2E', () => {
  it('--help exits 0 and prints usage', async () => {
    const { stdout, code } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Fedi CLI/);
    assert.match(stdout, /USAGE/);
    assert.match(stdout, /--help/);
    assert.match(stdout, /--sessions/);
  });

  it('--version exits 0 and prints version', async () => {
    const { stdout, code } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.match(stdout, /^fedi-cli v\d+\.\d+\.\d+/);
  });

  it('-h is an alias for --help', async () => {
    const { stdout, code } = await runCli(['-h']);
    assert.equal(code, 0);
    assert.match(stdout, /Fedi CLI/);
    assert.match(stdout, /USAGE/);
  });

  it('-v is an alias for --version', async () => {
    const { stdout, code } = await runCli(['-v']);
    assert.equal(code, 0);
    assert.match(stdout, /^fedi-cli v\d+\.\d+\.\d+/);
  });

  it('--sessions exits 0 (empty list is ok)', async () => {
    // Run in /tmp so no sessions directory exists — should not crash
    const { stdout, code } = await runCli(['--sessions'], { cwd: '/tmp' });
    assert.equal(code, 0);
    assert.ok(typeof stdout === 'string');
  });
});
