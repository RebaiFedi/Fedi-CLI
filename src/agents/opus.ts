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
  protected get effort() {
    return cfg.opusEffort;
  }
  protected get thinking() {
    return cfg.opusThinking;
  }

  protected override getExtraArgs(systemPrompt: string): string[] {
    // When resuming, the session already has its system prompt — don't override it
    if (this.sessionId) return [];
    return ['--system-prompt', systemPrompt];
  }

  /**
   * Override: don't send any initial message at start.
   * Opus is either pre-warmed (task sent later via send()) or cold-started
   * with the task sent by the orchestrator after start() resolves.
   */
  protected override async sendInitialMessage(_systemPrompt: string): Promise<void> {
    // No-op: the system prompt is passed via --system-prompt flag.
    // The first user message (task) will be sent by the orchestrator.
  }
}
