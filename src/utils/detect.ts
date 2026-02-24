import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CLIInfo {
  available: boolean;
  path?: string;
  version?: string;
}

async function detectCLI(name: string, versionFlag = '--version'): Promise<CLIInfo> {
  try {
    const { stdout } = await execFileAsync('which', [name]);
    const cliPath = stdout.trim();
    try {
      const { stdout: ver } = await execFileAsync(cliPath, [versionFlag]);
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
