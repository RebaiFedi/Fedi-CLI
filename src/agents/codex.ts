import type { SessionConfig } from './types.js';
import { BaseAppServerAgent } from './base-app-server-agent.js';
import { loadUserConfig } from '../config/user-config.js';

const cfg = loadUserConfig();

export class CodexAgent extends BaseAppServerAgent {
  readonly id = 'codex' as const;

  protected get logTag() { return '[CODEX]'; }
  protected get model() { return cfg.codexModel; }

  protected getCliPath(config: SessionConfig): string {
    return config.codexPath;
  }
}
