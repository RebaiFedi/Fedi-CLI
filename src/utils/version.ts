import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '../../package.json');

let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
} catch {
  // Fallback silently — package.json may be missing in bundled builds
}

export const VERSION: string = version;
