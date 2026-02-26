import type { AgentId } from './types.js';
import { BaseClaudeAgent } from './base-claude-agent.js';

export class OpusAgent extends BaseClaudeAgent {
  readonly id: AgentId = 'opus';
  protected get logTag() {
    return 'OPUS';
  }
  protected get model() {
    return 'claude-opus-4-6';
  }
}
