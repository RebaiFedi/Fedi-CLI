import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '../bin/fedi.js');

/**
 * Run the CLI as a child process and return { stdout, stderr, code }.
 * Uses spawn + stream collection for reliable stdout capture —
 * waits for the 'close' event which fires after all stdio is flushed.
 */
function runCli(
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 10_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        code,
      });
    });
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
    assert.match(stdout, /fedi-cli v\d+\.\d+\.\d+/);
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
    assert.match(stdout, /fedi-cli v\d+\.\d+\.\d+/);
  });

  it('--sessions exits 0 (empty list is ok)', async () => {
    // Run in /tmp so no sessions directory exists — should not crash
    const { stdout, code } = await runCli(['--sessions'], { cwd: '/tmp' });
    assert.equal(code, 0);
    assert.ok(typeof stdout === 'string');
  });
});
