import { useEffect, type MutableRefObject, type Dispatch } from 'react';
import chalk from 'chalk';
import type {
  AgentId,
  AgentStatus,
  ChatMessage,
  DisplayEntry,
  Message,
  OutputLine,
} from '../agents/types.js';
import type { TodoItem } from './TodoPanel.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { THEME, agentHex, agentDisplayName, agentChalkColor } from '../config/theme.js';
import { INDENT, MSG_CLOSE_GRACE_MS } from '../config/constants.js';
import { outputToEntries } from '../rendering/output-transform.js';
import { entriesToAnsiOutputLines } from '../rendering/ansi-renderer.js';
import { compactOutputLines } from '../rendering/compact.js';
import { printSessionResume } from './SessionResumeView.js';
import { buildResumePrompt } from '../utils/session-manager.js';
import { flog } from '../utils/log.js';

const VALID_AGENT_IDS = new Set<string>(['opus', 'sonnet', 'codex']);

interface UseOrchestratorBindingDeps {
  orchestrator: Orchestrator;
  exit: () => void;
  projectDir: string;
  claudePath: string;
  codexPath: string;
  resumeSessionId?: string;
  enabledAgentSet: Set<AgentId>;

  // State setters
  dispatchStatus: Dispatch<{ agent: string; status: AgentStatus }>;
  agentStatusesRef: MutableRefObject<Record<string, AgentStatus>>;
  setAgentErrors: (
    fn: (prev: Partial<Record<string, string>>) => Partial<Record<string, string>>,
  ) => void;
  stoppedRef: MutableRefObject<boolean>;
  setThinking: (v: boolean) => void;
  setTodos: (fn: (prev: TodoItem[]) => TodoItem[]) => void;
  setTodosHiddenAt: (v: number) => void;

  // Refs
  currentMsgRef: MutableRefObject<Map<string, string>>;
  lastEntryKind: MutableRefObject<Map<string, DisplayEntry['kind']>>;
  chatMessagesMap: MutableRefObject<Map<string, ChatMessage>>;
  msgCloseTimers: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  pendingActions: MutableRefObject<Map<AgentId, string[]>>;
  lastActionTime: MutableRefObject<Map<AgentId, number>>;
  lastHeartbeatTime: MutableRefObject<Map<AgentId, number>>;
  pendingAgentDones: MutableRefObject<Map<AgentId, string[]>>;
  thinkingClearTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  exitInProgress: MutableRefObject<boolean>;
  flushTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;

  // Callbacks
  processTaskTags: (agent: AgentId, text: string) => void;
  enqueueOutput: (agent: AgentId, entries: DisplayEntry[]) => void;
  flushBuffer: () => void;
  applyDones: (dones: string[]) => void;
}

/**
 * Hook that binds the orchestrator callbacks (onAgentOutput, onAgentStatus,
 * onRelay), handles session resume, and registers SIGINT/SIGTERM handlers.
 */
export function useOrchestratorBinding(deps: UseOrchestratorBindingDeps) {
  const {
    orchestrator,
    exit,
    projectDir,
    claudePath,
    codexPath,
    resumeSessionId,
    enabledAgentSet,
    dispatchStatus,
    agentStatusesRef,
    setAgentErrors,
    stoppedRef,
    setThinking,
    currentMsgRef,
    lastEntryKind,
    chatMessagesMap,
    msgCloseTimers,
    pendingActions,
    lastActionTime,
    lastHeartbeatTime,
    pendingAgentDones,
    thinkingClearTimer,
    exitInProgress,
    flushTimer,
    processTaskTags,
    enqueueOutput,
    flushBuffer,
    applyDones,
  } = deps;

  useEffect(() => {
    orchestrator.setConfig({ projectDir, claudePath, codexPath });
    orchestrator.setEnabledAgents(enabledAgentSet);
    orchestrator.bind({
      onAgentOutput: (agent: AgentId, line: OutputLine) => {
        if (stoppedRef.current) return;
        if (line.type === 'stdout') processTaskTags(agent, line.text);
        const entries = outputToEntries(line);
        if (entries.length === 0) return;
        enqueueOutput(agent, entries);
      },
      onAgentStatus: (agent: AgentId, status: AgentStatus) => {
        dispatchStatus({ agent, status });
        agentStatusesRef.current = { ...agentStatusesRef.current, [agent]: status };

        if (status === 'error') {
          setAgentErrors((prev) => {
            if (prev[agent] === 'error') return prev;
            return { ...prev, [agent]: `Agent ${agent} en erreur` };
          });
        } else if (
          status === 'running' ||
          status === 'idle' ||
          status === 'waiting' ||
          status === 'compacting'
        ) {
          setAgentErrors((prev) => {
            if (!(agent in prev)) return prev;
            const n = { ...prev };
            delete n[agent];
            return n;
          });
        }

        if (stoppedRef.current) return;

        if (status === 'running' || status === 'compacting') {
          const graceTimer = msgCloseTimers.current.get(agent);
          if (graceTimer) {
            clearTimeout(graceTimer);
            msgCloseTimers.current.delete(agent);
          }
          if (thinkingClearTimer.current) {
            clearTimeout(thinkingClearTimer.current);
            thinkingClearTimer.current = null;
          }
          setThinking(true);
        } else {
          const currentStatuses = { ...agentStatusesRef.current, [agent]: status };
          const anyActiveNow = Object.values(currentStatuses).some(
            (s) => s === 'running' || s === 'compacting',
          );
          const pendingDelegates = orchestrator.hasPendingDelegates;
          if (!anyActiveNow && !pendingDelegates && !thinkingClearTimer.current) {
            thinkingClearTimer.current = setTimeout(() => {
              thinkingClearTimer.current = null;
              setThinking(false);
            }, 300);
          }
        }

        if (
          status === 'waiting' ||
          status === 'idle' ||
          status === 'error' ||
          status === 'stopped'
        ) {
          lastActionTime.current.delete(agent);
          lastHeartbeatTime.current.delete(agent);

          if (agent === 'sonnet' || agent === 'codex') {
            const buffered = pendingAgentDones.current.get(agent);
            if (buffered && buffered.length > 0) {
              pendingAgentDones.current.set(agent, []);
              applyDones(buffered);
            }
          }

          if (flushTimer.current) {
            clearTimeout(flushTimer.current);
            flushBuffer();
          }
          const remaining = pendingActions.current.get(agent);
          if (remaining && remaining.length > 0) {
            const ac = agentChalkColor(agent);
            const summary: DisplayEntry[] = remaining.map((a) => ({
              text: a,
              kind: 'action' as const,
            }));
            const lines = entriesToAnsiOutputLines(summary, ac);
            if (lines.length > 0) console.log(compactOutputLines(lines).join('\n'));
            pendingActions.current.set(agent, []);
          }

          const currentId = currentMsgRef.current.get(agent);
          if (currentId) {
            if (status === 'waiting') {
              const prevTimer = msgCloseTimers.current.get(agent);
              if (prevTimer) clearTimeout(prevTimer);
              const timer = setTimeout(() => {
                msgCloseTimers.current.delete(agent);
                const stillId = currentMsgRef.current.get(agent);
                if (stillId === currentId) {
                  const msg = chatMessagesMap.current.get(currentId);
                  if (msg) msg.status = 'done';
                  currentMsgRef.current.delete(agent);
                  lastEntryKind.current.delete(agent);
                  console.log('');
                }
              }, MSG_CLOSE_GRACE_MS);
              msgCloseTimers.current.set(agent, timer);
            } else {
              const prevTimer = msgCloseTimers.current.get(agent);
              if (prevTimer) {
                clearTimeout(prevTimer);
                msgCloseTimers.current.delete(agent);
              }
              const msg = chatMessagesMap.current.get(currentId);
              if (msg) msg.status = 'done';
              currentMsgRef.current.delete(agent);
              lastEntryKind.current.delete(agent);
              console.log('');
            }
          }
        }
      },
      onRelay: (msg: Message) => {
        if (stoppedRef.current) return;
        flog.info('UI', `Relay: ${msg.from}->${msg.to}`);
        const trimmedContent = msg.content.trim();
        if (!trimmedContent || trimmedContent.replace(/[`'".,;:\-–—\s]/g, '').length < 3) {
          flog.debug('UI', `Relay display skipped (empty/fragment): ${msg.from}->${msg.to}`);
          return;
        }
        const fromId = msg.from as string;
        const toId = msg.to as string;
        const isFromUser = fromId === 'user';
        const fromAgent: AgentId = VALID_AGENT_IDS.has(fromId) ? (fromId as AgentId) : 'opus';
        const toAgent: AgentId = VALID_AGENT_IDS.has(toId) ? (toId as AgentId) : 'opus';
        const fromName = isFromUser ? 'User' : agentDisplayName(fromAgent);
        const toName = agentDisplayName(toAgent);
        const fromColor = isFromUser ? THEME.userPrefix : agentHex(fromAgent);
        const toColor = agentHex(toAgent);
        const relayHeader = `${INDENT}${chalk.hex(fromColor).bold(fromName)} ${chalk.dim('to')} ${chalk.hex(toColor).bold(toName)}`;
        const fakeOutputLine: OutputLine = {
          text: msg.content,
          timestamp: Date.now(),
          type: 'stdout',
        };
        const entries = outputToEntries(fakeOutputLine);
        const relayChalkColor = isFromUser ? ('cyan' as const) : agentChalkColor(fromAgent);
        const relayOut = entriesToAnsiOutputLines(entries, relayChalkColor);
        console.log(`\n${relayHeader}\n${relayOut.join('\n')}\n`);
      },
      onRelayBlocked: (msg: Message) => {
        flog.info('UI', `Relay blocked: ${msg.from}->${msg.to}`);
      },
    });

    // Pre-spawn Opus process at app startup (unless resuming a session).
    // Just spawns the CLI process (~200ms) — no message sent, no API connection.
    // The system prompt + user task will be sent together on first user input.
    if (!resumeSessionId) {
      orchestrator.prewarmOpus().catch((err) => {
        flog.error('UI', `[DASHBOARD] Opus pre-spawn error: ${err}`);
      });
    }

    // Resume session if --resume flag was passed
    if (resumeSessionId) {
      (async () => {
        const sm = orchestrator.getSessionManager();
        if (!sm) return;
        const sessions = await sm.listSessions();
        const match = sessions.find((s) => s.id.startsWith(resumeSessionId));
        if (match) {
          const session = await sm.loadSession(match.id);
          if (session) {
            printSessionResume(session, match.id);
            const resumePrompt = buildResumePrompt(session);
            setThinking(true);
            orchestrator.startWithTask(resumePrompt).catch((err) => {
              flog.error('UI', `[DASHBOARD] Resume error: ${err}`);
              if (stoppedRef.current) setThinking(false);
            });
          } else {
            console.log(chalk.red(`  Session ${resumeSessionId} non trouvee ou corrompue.`));
          }
        } else {
          console.log(chalk.red(`  Session ${resumeSessionId} non trouvee.`));
          console.log(chalk.dim('  Utilisez: fedi --sessions pour voir la liste.'));
        }
      })().catch((err) => flog.error('UI', `[DASHBOARD] Session resume error: ${err}`));
    }

    const handleExit = () => {
      if (exitInProgress.current) {
        flog.warn('UI', 'Force exit requested');
        // Force shutdown — still go through orchestrator.stop() for cleanup
        orchestrator
          .stop()
          .catch(() => {})
          .finally(() => {
            process.exitCode = 1;
            exit();
          });
        return;
      }
      const activeAgents = Object.entries(agentStatusesRef.current)
        .filter(([, s]) => s === 'running')
        .map(([a]) => a);
      if (activeAgents.length > 0 && !stoppedRef.current) {
        exitInProgress.current = true;
        console.log(
          chalk.yellow(
            `\n  Agents actifs (${activeAgents.join(', ')}) — Ctrl+C encore pour forcer.`,
          ),
        );
      } else {
        exitInProgress.current = true;
      }
      flog.info('UI', 'Graceful shutdown initiated...');
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushBuffer();
      }
      orchestrator
        .stop()
        .catch((err) => flog.error('UI', `Shutdown error: ${err}`))
        .finally(() => {
          flog.info('UI', 'Shutdown complete');
          exit();
        });
    };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
    // Capture current ref values for cleanup (React hooks lint rule)
    const capturedFlushTimer = flushTimer;
    const capturedThinkingTimer = thinkingClearTimer;
    const capturedMsgCloseTimers = msgCloseTimers;
    return () => {
      process.off('SIGINT', handleExit);
      process.off('SIGTERM', handleExit);
      if (capturedFlushTimer.current) clearTimeout(capturedFlushTimer.current);
      if (capturedThinkingTimer.current) clearTimeout(capturedThinkingTimer.current);
      // Clear all message-close timers to prevent leaks
      for (const timer of capturedMsgCloseTimers.current.values()) {
        clearTimeout(timer);
      }
      capturedMsgCloseTimers.current.clear();
    };
  }, [
    orchestrator,
    exit,
    projectDir,
    claudePath,
    codexPath,
    resumeSessionId,
    enabledAgentSet,
    processTaskTags,
    enqueueOutput,
    flushBuffer,
    applyDones,
    dispatchStatus,
    agentStatusesRef,
    setAgentErrors,
    stoppedRef,
    setThinking,
    currentMsgRef,
    lastEntryKind,
    chatMessagesMap,
    msgCloseTimers,
    pendingActions,
    lastActionTime,
    lastHeartbeatTime,
    pendingAgentDones,
    thinkingClearTimer,
    exitInProgress,
    flushTimer,
  ]);
}
