import type { SessionConfig } from './types.js';
import { BaseAppServerAgent } from './base-app-server-agent.js';
import { loadUserConfig } from '../config/user-config.js';

export class CodexAgent extends BaseAppServerAgent {
  readonly id = 'codex' as const;

  protected get logTag() {
    return '[CODEX]';
  }
  protected get model() {
    return loadUserConfig().codexModel;
  }
  protected get effort() {
    return loadUserConfig().codexEffort;
  }
  protected get thinking() {
    return loadUserConfig().codexThinking;
  }

  protected getCliPath(config: SessionConfig): string {
    return config.codexPath;
  }
}
