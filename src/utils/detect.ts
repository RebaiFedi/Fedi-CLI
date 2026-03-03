import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CLIInfo {
  available: boolean;
  path?: string;
  version?: string;
}

const DETECT_TIMEOUT_MS = 5000;

/** Cross-platform CLI lookup: `where` on Windows, `which` elsewhere. */
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

async function detectCLI(name: string, versionFlag = '--version'): Promise<CLIInfo> {
  try {
    const { stdout } = await execFileAsync(WHICH_CMD, [name], { timeout: DETECT_TIMEOUT_MS });
    const cliPath = stdout.trim().split('\n')[0];
    try {
      const { stdout: ver } = await execFileAsync(cliPath, [versionFlag], {
        timeout: DETECT_TIMEOUT_MS,
      });
      return { available: true, path: cliPath, version: ver.trim().split('\n')[0] };
    } catch {
      return { available: true, path: cliPath };
    }
  } catch {
    return { available: false };
  }
}

export async function detectClaude(): Promise<CLIInfo> {
  return detectCLI('claude');
}

export async function detectCodex(): Promise<CLIInfo> {
  return detectCLI('codex');
}

export async function detectAll(): Promise<{ claude: CLIInfo; codex: CLIInfo }> {
  const [claude, codex] = await Promise.all([detectClaude(), detectCodex()]);
  return { claude, codex };
}
