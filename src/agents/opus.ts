import type { AgentId } from './types.js';
import { BaseSonnetAgent } from './base-sonnet-agent.js';
import { loadUserConfig } from '../config/user-config.js';

const cfg = loadUserConfig();

export class OpusAgent extends BaseSonnetAgent {
  readonly id: AgentId = 'opus';

  protected get logTag() {
    return 'OPUS';
  }
  protected get model() {
    return cfg.opusModel;
  }
}
