import React from 'react';
import { render } from 'ink';
import { detectAll } from './utils/detect.js';
import { logger } from './utils/logger.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { Dashboard } from './ui/Dashboard.js';

export async function main() {
  logger.info('=== Fedi CLI starting ===');

  const clis = await detectAll();

  if (!clis.gemini.available) {
    console.error('Gemini CLI not found. Install with: npm i -g @anthropic-ai/gemini-cli');
    process.exit(1);
  }

  if (!clis.claude.available) {
    console.error('Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code');
    process.exit(1);
  }

  if (!clis.codex.available) {
    console.error('Codex CLI not found. Install with: npm i -g @openai/codex');
    process.exit(1);
  }

  const projectDir = process.cwd();
  const orchestrator = new Orchestrator();

  logger.info(`[MAIN] Project: ${projectDir}`);

  const { waitUntilExit } = render(
    <Dashboard
      orchestrator={orchestrator}
      projectDir={projectDir}
      geminiPath={clis.gemini.path!}
      claudePath={clis.claude.path!}
      codexPath={clis.codex.path!}
    />,
  );

  await waitUntilExit();
  logger.info('=== Fedi CLI exiting ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
