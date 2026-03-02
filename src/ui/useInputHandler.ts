import { useCallback, type MutableRefObject } from 'react';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import type { AgentId, ChatMessage } from '../agents/types.js';
import type { TodoItem } from './TodoPanel.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { THEME } from '../config/theme.js';
import { printUserBubble } from './UserBubble.js';
import { flog } from '../utils/log.js';

interface UseInputHandlerDeps {
  orchestrator: Orchestrator;
  stopped: boolean;
  enabledAgentSet: Set<AgentId>;
  handleSlashCommand: (cmd: string, args: string[]) => boolean;
  chatMessagesMap: MutableRefObject<Map<string, ChatMessage>>;
  pendingAgentDones: MutableRefObject<Map<AgentId, string[]>>;
  stoppedRef: MutableRefObject<boolean>;
  setShowSlashMenu: (v: boolean) => void;
  setThinking: (v: boolean) => void;
  setStopped: (v: boolean) => void;
  setTodos: (fn: (prev: TodoItem[]) => TodoItem[]) => void;
}

/**
 * Hook that handles user input: slash commands, @agent routing,
 * @sessions, @tous, restart on stopped, and default message send.
 */
export function useInputHandler({
  orchestrator,
  stopped,
  enabledAgentSet,
  handleSlashCommand,
  chatMessagesMap,
  pendingAgentDones,
  stoppedRef,
  setShowSlashMenu,
  setThinking,
  setStopped,
  setTodos,
}: UseInputHandlerDeps) {
  return useCallback(
    (text: string) => {
      flog.info('UI', `User input: ${text.slice(0, 100)}`);

      // ── Slash commands — local config, not sent to agents ──────────────
      if (text.trim().startsWith('/')) {
        const trimmed = text.trim();
        // "/" alone → open interactive menu
        if (trimmed === '/') {
          setShowSlashMenu(true);
          return;
        }
        const parts = trimmed.slice(1).split(/\s+/);
        const cmd = parts[0]?.toLowerCase() ?? '';
        const slashHandled = handleSlashCommand(cmd, parts.slice(1));
        if (slashHandled) return;
      }

      printUserBubble(text);
      const userMsgId = randomUUID();
      chatMessagesMap.current.set(userMsgId, {
        id: userMsgId,
        agent: 'user',
        lines: [{ text, kind: 'text' }],
        timestamp: Date.now(),
        status: 'done',
      });

      setThinking(true);

      // @sessions command
      if (/^@sessions\s*$/i.test(text.trim())) {
        const sm = orchestrator.getSessionManager();
        if (!sm) {
          console.log(chalk.dim('    Session manager not initialized yet.'));
          setThinking(false);
          return;
        }
        (async () => {
          const sessions = await sm.listSessions();
          if (sessions.length === 0) {
            console.log(chalk.dim('    Aucune session enregistree.'));
          } else {
            const sessionLines: string[] = [
              '',
              chalk.white.bold('    Sessions enregistrees'),
              chalk.dim('    ' + '\u2500'.repeat(50)),
            ];
            for (const s of sessions.slice(0, 10)) {
              const date = new Date(s.startedAt);
              const dateStr = date.toLocaleDateString('fr-FR', {
                day: '2-digit',
                month: '2-digit',
              });
              const timeStr = date.toLocaleTimeString('fr-FR', {
                hour: '2-digit',
                minute: '2-digit',
              });
              const status = s.finishedAt
                ? chalk.hex(THEME.codex)('done')
                : chalk.hex(THEME.info)('run');
              const task = s.task.length > 40 ? s.task.slice(0, 40) + '...' : s.task;
              const shortId = s.id.slice(0, 8);
              sessionLines.push(
                `    ${chalk.dim(dateStr)} ${chalk.dim(timeStr)}  ${chalk.hex(THEME.sonnet)(shortId)}  ${status}  ${chalk.hex(THEME.text)(task)}`,
              );
            }
            sessionLines.push('', chalk.dim('    Voir en detail: fedi --view <id>'), '');
            console.log(sessionLines.join('\n'));
          }
        })()
          .catch((err) => flog.error('UI', `[DASHBOARD] Sessions list error: ${err}`))
          .finally(() => setThinking(false));
        return;
      }

      // @tous / @all — send directly to all 3 agents
      const allMatch = text.match(/^@(tous|all)\s+(.+)$/i);
      if (allMatch) {
        const allMessage = allMatch[2];
        if (!orchestrator.isStarted || stopped) {
          const isRestart = stopped;
          setStopped(false);
          stoppedRef.current = false;
          setTodos(() => []);
          pendingAgentDones.current.clear();
          if (isRestart) console.log('Redemarrage...');
          orchestrator
            .restart(allMessage)
            .then(() => {
              orchestrator.sendToAllDirect(allMessage);
            })
            .catch((err) => flog.error('UI', `[DASHBOARD] Start error: ${err}`));
        } else {
          orchestrator.sendToAllDirect(allMessage);
        }
        return;
      }

      // Parse @agent commands
      let targetAgent: AgentId | null = null;
      let agentMessage = text;
      const agentPrefixes: { prefix: string; agent: AgentId }[] = [
        { prefix: '@opus ', agent: 'opus' },
        { prefix: '@codex ', agent: 'codex' },
        { prefix: '@sonnet ', agent: 'sonnet' },
        { prefix: '@claude ', agent: 'sonnet' },
      ];
      for (const { prefix, agent } of agentPrefixes) {
        if (text.toLowerCase().startsWith(prefix)) {
          targetAgent = agent;
          agentMessage = text.slice(prefix.length);
          break;
        }
      }

      // Block commands to disabled agents
      if (targetAgent && !enabledAgentSet.has(targetAgent)) {
        console.log(
          chalk.yellow(
            `  Agent @${targetAgent} est desactive. Agents actifs: ${[...enabledAgentSet].join(', ')}`,
          ),
        );
        setThinking(false);
        return;
      }

      // Detect unknown @commands and show error + suggestion
      const unknownAtMatch = text.match(/^@(\S+)/);
      if (unknownAtMatch && !targetAgent) {
        const typed = unknownAtMatch[1].toLowerCase();
        const knownCommands = ['opus', 'codex', 'sonnet', 'claude', 'tous', 'all', 'sessions'];
        const suggestion = knownCommands.find(
          (cmd) => cmd.startsWith(typed.slice(0, 2)) || typed.startsWith(cmd.slice(0, 2)),
        );
        const suggestionText = suggestion
          ? ` Vous vouliez dire ${chalk.white(`@${suggestion}`)} ?`
          : '';
        console.log(chalk.yellow(`  Commande inconnue: @${typed}.${suggestionText}`));
        console.log(
          chalk.dim(
            '  Commandes disponibles: @opus, @codex, @claude, @sonnet, @tous, @all, @sessions',
          ),
        );
        setThinking(false);
        return;
      }

      if (!orchestrator.isStarted || stopped) {
        const isRestart = stopped;
        setStopped(false);
        stoppedRef.current = false;
        setTodos(() => []);
        pendingAgentDones.current.clear();
        if (targetAgent && targetAgent !== 'opus') {
          const agentNames: Record<string, string> = { claude: 'Sonnet', codex: 'Codex' };
          if (isRestart) console.log('Redemarrage...');
          orchestrator.setDirectMode(targetAgent);
          orchestrator
            .restart(
              `Le user parle directement a ${agentNames[targetAgent] ?? targetAgent} via @${targetAgent}. NE FAIS RIEN. N'execute AUCUNE tache. Attends en silence.`,
            )
            .then(() => {
              orchestrator.sendToAgent(targetAgent!, agentMessage);
            })
            .catch((err) => flog.error('UI', `[DASHBOARD] Start error: ${err}`));
        } else {
          if (isRestart) console.log('Redemarrage...');
          orchestrator
            .restart(targetAgent === 'opus' ? agentMessage : text)
            .catch((err) => flog.error('UI', `[DASHBOARD] Start error: ${err}`));
        }
        return;
      }

      if (targetAgent) {
        orchestrator.sendToAgent(targetAgent, agentMessage);
        return;
      }

      orchestrator.sendUserMessage(text);
    },
    [
      orchestrator,
      stopped,
      enabledAgentSet,
      handleSlashCommand,
      chatMessagesMap,
      pendingAgentDones,
      stoppedRef,
      setShowSlashMenu,
      setThinking,
      setStopped,
      setTodos,
    ],
  );
}
