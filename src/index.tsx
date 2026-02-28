import React from 'react';
import { render } from 'ink';
import chalk from 'chalk';
import { detectAll } from './utils/detect.js';
import { initLog, flog } from './utils/log.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { Dashboard } from './ui/Dashboard.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { SessionManager } from './utils/session-manager.js';
import { THEME } from './config/theme.js';

async function printSessionList(projectDir: string) {
  const sm = new SessionManager(projectDir);
  const sessions = await sm.listSessions();

  if (sessions.length === 0) {
    console.log(chalk.dim('  Aucune session trouvee.'));
    console.log(chalk.dim(`  Les sessions sont sauvegardees dans: ${projectDir}/sessions/`));
    return;
  }

  console.log('');
  console.log(chalk.hex(THEME.text).bold('  Sessions enregistrees'));
  console.log(chalk.dim('  ' + '─'.repeat(60)));

  for (const s of sessions) {
    const date = new Date(s.startedAt);
    const dateStr = date.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const status = s.finishedAt
      ? chalk.hex(THEME.codex)('done')
      : chalk.hex(THEME.info)('interrupted');
    const task = s.task.length > 50 ? s.task.slice(0, 50) + '...' : s.task;
    const shortId = s.id.slice(0, 8);

    console.log(
      `  ${chalk.dim(dateStr)} ${chalk.dim(timeStr)}  ${chalk.hex(THEME.sonnet)(shortId)}  ${status}  ${chalk.hex(THEME.text)(task)}`,
    );
  }

  console.log('');
  console.log(chalk.dim('  Voir:     fedi --view <id>'));
  console.log(chalk.dim('  Reprendre: fedi --resume <id>'));
  console.log('');
}

async function viewSession(projectDir: string, sessionId: string) {
  const sm = new SessionManager(projectDir);

  // Support short IDs (first 8 chars)
  const sessions = await sm.listSessions();
  const match = sessions.find((s) => s.id.startsWith(sessionId));
  if (!match) {
    console.error(chalk.red(`  Session "${sessionId}" non trouvee.`));
    console.log(chalk.dim('  Utilisez: fedi --sessions pour voir la liste.'));
    return;
  }

  const session = await sm.loadSession(match.id);
  if (!session) {
    console.error(chalk.red(`  Impossible de charger la session ${match.id}`));
    return;
  }

  const startDate = new Date(session.startedAt);
  const dateStr =
    startDate.toLocaleDateString('fr-FR') +
    ' ' +
    startDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const duration = session.finishedAt
    ? `${Math.round((session.finishedAt - session.startedAt) / 1000)}s`
    : 'interrompue';

  const agentLabels: Record<string, { label: string; color: (s: string) => string }> = {
    opus: { label: 'Opus', color: chalk.hex(THEME.opus) },
    claude: { label: 'Sonnet', color: chalk.hex(THEME.sonnet) },
    codex: { label: 'Codex', color: chalk.hex(THEME.codex) },
    user: { label: 'User', color: chalk.hex(THEME.text) },
    system: { label: 'System', color: chalk.dim },
  };

  console.log('');
  console.log(chalk.hex(THEME.text).bold(`  Session ${session.id.slice(0, 8)}`));
  console.log(chalk.dim('  ' + '─'.repeat(60)));
  console.log(`  ${chalk.dim('Tache:')} ${chalk.hex(THEME.text)(session.task)}`);
  console.log(`  ${chalk.dim('Date:')} ${dateStr}  ${chalk.dim('Duree:')} ${duration}`);
  console.log(`  ${chalk.dim('Messages:')} ${session.messages.length}`);

  // Show agent sessions
  const agents = Object.entries(session.agentSessions);
  if (agents.length > 0) {
    console.log(
      `  ${chalk.dim('Agents:')} ${agents.map(([a, id]) => `${agentLabels[a]?.label ?? a}(${(id as string).slice(0, 8)})`).join(', ')}`,
    );
  }

  console.log(chalk.dim('  ' + '─'.repeat(60)));
  console.log('');

  // Display messages
  for (const msg of session.messages) {
    const agent = agentLabels[msg.from] ?? { label: msg.from, color: chalk.white };
    const target = agentLabels[msg.to] ?? { label: msg.to, color: chalk.white };
    const time = new Date(msg.timestamp).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const content = msg.content.length > 120 ? msg.content.slice(0, 120) + '...' : msg.content;

    console.log(
      `  ${chalk.dim(time)} ${agent.color(agent.label)} ${chalk.dim('->')} ${target.color(target.label)}`,
    );
    console.log(`    ${chalk.hex(THEME.text)(content)}`);
    console.log('');
  }
}

function printHelp() {
  console.log(`
${chalk.hex(THEME.opus).bold('Fedi CLI')} ${chalk.dim('v1.0.0')} — Orchestrateur multi-agents IA

${chalk.white.bold('USAGE')}
  fedi [options]                Lancer une session interactive
  fedi --sessions              Lister les sessions sauvegardees
  fedi --view <id>             Voir le transcript d'une session
  fedi --resume <id>           Reprendre une session interrompue

${chalk.white.bold('OPTIONS')}
  -h, --help                   Afficher cette aide
  --sessions                   Lister toutes les sessions
  --view <id>                  Afficher une session (supporte les IDs courts)
  --resume <id>                Reprendre une session precedente
  --agents <list>              Agents a activer (ex: opus,claude,codex)


${chalk.white.bold('COMMANDES INTERACTIVES')}
  @opus <message>              Parler directement a Opus (directeur)
  @sonnet <message>            Parler directement a Claude/Sonnet (frontend)
  @codex <message>             Parler directement a Codex (backend)
  @tous <message>              Envoyer a tous les agents
  @sessions                    Lister les sessions

${chalk.white.bold('RACCOURCIS')}
  ${chalk.dim('Esc')}                          Arreter les agents en cours
  ${chalk.dim('Ctrl+C')}                       Quitter

${chalk.white.bold('AGENTS')}
  ${chalk.hex(THEME.opus)('Opus')}     Claude Opus 4.6     Directeur / orchestrateur
  ${chalk.hex(THEME.sonnet)('Sonnet')}   Claude Sonnet 4.6   Specialiste frontend
  ${chalk.hex(THEME.codex)('Codex')}    GPT-5.3 Codex       Specialiste backend


${chalk.dim('Logs:     ~/.fedi-cli/logs/')}
${chalk.dim('Sessions: ./sessions/')}
`);
}

export async function main() {
  // Initialize unified logging — writes to ~/.fedi-cli/logs/
  initLog();
  flog.info('SYSTEM', '=== Fedi CLI starting ===');

  const args = process.argv.slice(2);

  // Handle --help flag
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Handle --sessions flag
  if (args.includes('--sessions')) {
    await printSessionList(process.cwd());
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
    await viewSession(process.cwd(), sessionId);
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

  // Handle --agents flag: restrict which agents are enabled
  const agentsIdx = args.indexOf('--agents');
  const enabledAgents = new Set<string>(['opus', 'sonnet', 'codex']);
  if (agentsIdx !== -1) {
    const agentList = args[agentsIdx + 1];
    if (!agentList) {
      console.error(chalk.red('  Usage: fedi --agents opus,claude,codex'));
      process.exit(1);
    }
    enabledAgents.clear();
    for (const a of agentList.split(',').map((s) => s.trim().toLowerCase())) {
      if (['opus', 'sonnet', 'codex', 'sonnet'].includes(a)) {
        enabledAgents.add(a === 'sonnet' ? 'sonnet' : a);
      } else {
        console.warn(chalk.yellow(`  Agent inconnu: ${a} (ignoring)`));
      }
    }
    // Opus is always required as director
    enabledAgents.add('opus');
    flog.info('SYSTEM', `Agents enabled: ${[...enabledAgents].join(', ')}`);
  }

  const clis = await detectAll();

  if (!clis.claude.available) {
    console.error('Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code');
    process.exit(1);
  }

  if (!clis.codex.available && enabledAgents.has('codex')) {
    console.error('Codex CLI not found. Install with: npm i -g @openai/codex');
    process.exit(1);
  }

  const projectDir = process.cwd();
  const orchestrator = new Orchestrator();
  const enabledAgentList = [...enabledAgents].filter(
    (a): a is 'opus' | 'sonnet' | 'codex' => a === 'opus' || a === 'sonnet' || a === 'codex',
  );
  orchestrator.setEnabledAgents(enabledAgentList);

  flog.info('SYSTEM', `Project: ${projectDir}`);

  const { waitUntilExit } = render(
    <ErrorBoundary>
      <Dashboard
        orchestrator={orchestrator}
        projectDir={projectDir}
        claudePath={clis.claude.path!}
        codexPath={clis.codex.path ?? ''}
        resumeSessionId={resumeSessionId}
        enabledAgents={enabledAgentList}
      />
    </ErrorBoundary>,
  );

  await waitUntilExit();
  flog.info('SYSTEM', '=== Fedi CLI exiting ===');
}

// Only auto-execute when run directly (not when imported by bin/fedi.js)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/src/index.tsx') || process.argv[1].endsWith('/src/index.js'));

if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
