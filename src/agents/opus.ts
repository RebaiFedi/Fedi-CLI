import type { AgentId } from './types.js';
import { BaseClaudeAgent } from './base-claude-agent.js';
import { loadUserConfig } from '../config/user-config.js';

const cfg = loadUserConfig();

export class OpusAgent extends BaseClaudeAgent {
  readonly id: AgentId = 'opus';
  protected get logTag() {
    return 'OPUS';
  }
  protected get model() {
    return cfg.opusModel;
  }
}
