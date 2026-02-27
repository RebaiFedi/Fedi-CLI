import type { AgentId, SessionConfig } from './types.js';
import { BaseClaudeAgent } from './base-claude-agent.js';
import { loadUserConfig } from '../config/user-config.js';

const cfg = loadUserConfig();

export class ClaudeAgent extends BaseClaudeAgent {
  readonly id: AgentId = 'claude';
  protected get logTag() {
    return 'CLAUDE';
  }
  protected get model() {
    return cfg.claudeModel;
  }

  protected override getExtraArgs(systemPrompt: string): string[] {
    // When resuming, the session already has its system prompt — don't override it
    if (this.sessionId) return [];
    return ['--system-prompt', systemPrompt];
  }

  /**
   * Override: don't send any initial message at start.
   * Claude is lazy-started — the first real task from the orchestrator
   * queue will be sent via send() right after start() resolves.
   * This avoids the mute/unmute complexity entirely.
   */
  protected override async sendInitialMessage(_systemPrompt: string): Promise<void> {
    // No-op: wait for the first real task via send()
  }

  override async start(config: SessionConfig, systemPrompt: string): Promise<void> {
    await super.start(config, systemPrompt);
    // No initial message sent — set to idle (not waiting!) so the
    // orchestrator's relay safety-net doesn't think we finished a task.
    // The status will change to 'running' when send() is called.
    this.setStatus('idle', false);
  }
}
