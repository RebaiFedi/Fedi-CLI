import type { AgentId, SessionConfig } from './types.js';
import { BaseClaudeAgent } from './base-claude-agent.js';

export class ClaudeAgent extends BaseClaudeAgent {
  readonly id: AgentId = 'claude';
  protected get logTag() {
    return 'CLAUDE';
  }
  protected get model() {
    return 'claude-sonnet-4-6';
  }

  protected override getExtraArgs(systemPrompt: string): string[] {
    return ['--system-prompt', systemPrompt];
  }

  /**
   * Override: don't send any initial message at start.
   * Claude is lazy-started — the first real task from the orchestrator
   * queue will be sent via send() right after start() resolves.
   * This avoids the mute/unmute complexity entirely.
   */
  protected override sendInitialMessage(_systemPrompt: string) {
    // No-op: wait for the first real task via send()
  }

  override async start(config: SessionConfig, systemPrompt: string): Promise<void> {
    await super.start(config, systemPrompt);
    // No initial message sent — set to idle (not waiting!) so the
    // orchestrator's relay safety-net doesn't think we finished a task.
    // The status will change to 'running' when send() is called.
    this.status = 'idle'; // Direct assignment — don't notify handlers
  }
}
