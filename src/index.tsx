import React from 'react';
import { render } from 'ink';
import chalk from 'chalk';
import { detectAll } from './utils/detect.js';
import { logger } from './utils/logger.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { Dashboard } from './ui/Dashboard.js';
import { SessionManager } from './utils/session-manager.js';

function printSessionList(projectDir: string) {
  const sm = new SessionManager(projectDir);
  const sessions = sm.listSessions();

  if (sessions.length === 0) {
    console.log(chalk.dim('  Aucune session trouvee.'));
    console.log(chalk.dim(`  Les sessions sont sauvegardees dans: ${projectDir}/sessions/`));
    return;
  }

  console.log('');
  console.log(chalk.white.bold('  Sessions enregistrees'));
  console.log(chalk.dim('  ' + '─'.repeat(60)));

  for (const s of sessions) {
    const date = new Date(s.startedAt);
    const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const status = s.finishedAt ? chalk.green('done') : chalk.yellow('interrupted');
    const task = s.task.length > 50 ? s.task.slice(0, 50) + '...' : s.task;
    const shortId = s.id.slice(0, 8);

    console.log(`  ${chalk.dim(dateStr)} ${chalk.dim(timeStr)}  ${chalk.cyanBright(shortId)}  ${status}  ${chalk.white(task)}`);
  }

  console.log('');
  console.log(chalk.dim('  Voir:     fedi --view <id>'));
  console.log(chalk.dim('  Reprendre: fedi --resume <id>'));
  console.log('');
}

function viewSession(projectDir: string, sessionId: string) {
  const sm = new SessionManager(projectDir);

  // Support short IDs (first 8 chars)
  const sessions = sm.listSessions();
  const match = sessions.find(s => s.id.startsWith(sessionId));
  if (!match) {
    console.error(chalk.red(`  Session "${sessionId}" non trouvee.`));
    console.log(chalk.dim('  Utilisez: fedi --sessions pour voir la liste.'));
    return;
  }

  const session = sm.loadSession(match.id);
  if (!session) {
    console.error(chalk.red(`  Impossible de charger la session ${match.id}`));
    return;
  }

  const startDate = new Date(session.startedAt);
  const dateStr = startDate.toLocaleDateString('fr-FR') + ' ' + startDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const duration = session.finishedAt
    ? `${Math.round((session.finishedAt - session.startedAt) / 1000)}s`
    : 'interrompue';

  const agentLabels: Record<string, { label: string; color: (s: string) => string }> = {
    opus: { label: 'Opus', color: chalk.magentaBright },
    claude: { label: 'Sonnet', color: chalk.cyanBright },
    codex: { label: 'Codex', color: chalk.greenBright },
    user: { label: 'User', color: chalk.white },
    system: { label: 'System', color: chalk.dim },
  };

  console.log('');
  console.log(chalk.white.bold(`  Session ${session.id.slice(0, 8)}`));
  console.log(chalk.dim('  ' + '─'.repeat(60)));
  console.log(`  ${chalk.dim('Tache:')} ${chalk.white(session.task)}`);
  console.log(`  ${chalk.dim('Date:')} ${dateStr}  ${chalk.dim('Duree:')} ${duration}`);
  console.log(`  ${chalk.dim('Messages:')} ${session.messages.length}`);

  // Show agent sessions
  const agents = Object.entries(session.agentSessions);
  if (agents.length > 0) {
    console.log(`  ${chalk.dim('Agents:')} ${agents.map(([a, id]) => `${agentLabels[a]?.label ?? a}(${(id as string).slice(0, 8)})`).join(', ')}`);
  }

  console.log(chalk.dim('  ' + '─'.repeat(60)));
  console.log('');

  // Display messages
  for (const msg of session.messages) {
    const agent = agentLabels[msg.from] ?? { label: msg.from, color: chalk.white };
    const target = agentLabels[msg.to] ?? { label: msg.to, color: chalk.white };
    const time = new Date(msg.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const content = msg.content.length > 120 ? msg.content.slice(0, 120) + '...' : msg.content;

    console.log(`  ${chalk.dim(time)} ${agent.color(agent.label)} ${chalk.dim('->')} ${target.color(target.label)}`);
    console.log(`    ${chalk.white(content)}`);
    console.log('');
  }
}

export async function main() {
  logger.info('=== Fedi CLI starting ===');

  const args = process.argv.slice(2);

  // Handle --sessions flag
  if (args.includes('--sessions')) {
    printSessionList(process.cwd());
    process.exit(0);
  }

  // Handle --view <id> flag
  const viewIdx = args.indexOf('--view');
  if (viewIdx !== -1) {
    const sessionId = args[viewIdx + 1];
    if (!sessionId) {
      console.error(chalk.red('  Usage: fedi --view <session-id>'));
      process.exit(1);
    }
    viewSession(process.cwd(), sessionId);
    process.exit(0);
  }

  // Handle --resume <id> flag
  const resumeIdx = args.indexOf('--resume');
  let resumeSessionId: string | undefined;
  if (resumeIdx !== -1) {
    resumeSessionId = args[resumeIdx + 1];
    if (!resumeSessionId) {
      console.error(chalk.red('  Usage: fedi --resume <session-id>'));
      process.exit(1);
    }
  }

  const clis = await detectAll();

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
      claudePath={clis.claude.path!}
      codexPath={clis.codex.path!}
      resumeSessionId={resumeSessionId}
    />,
  );

  await waitUntilExit();
  logger.info('=== Fedi CLI exiting ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
