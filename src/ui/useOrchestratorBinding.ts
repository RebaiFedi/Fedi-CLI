import { useEffect, useRef, type MutableRefObject, type Dispatch } from 'react';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
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
const LIVE_STREAM_MIN_TEXT_LEN = 60;
const LIVE_STREAM_STEP_MS = 12;

function getLiveChunkLen(): number {
  const termW = process.stdout.columns || 80;
  return Math.max(100, termW - 6);
}

function splitLongText(text: string, maxLen: number): string[] {
  if (stripAnsi(text).length <= maxLen) return [text];
  const lines = text.split('\n');
  const out: string[] = [];

  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      out.push('');
      continue;
    }
    const words = rawLine.split(/\s+/);
    let current = '';
    for (const w of words) {
      if (!current) {
        current = w;
        continue;
      }
      const candidate = `${current} ${w}`;
      if (stripAnsi(candidate).length > maxLen) {
        out.push(current);
        current = w;
      } else {
        current = candidate;
      }
    }
    if (current) out.push(current);
  }

  return out.length > 0 ? out : [text];
}

function splitEntriesForLive(entries: DisplayEntry[], maxLen: number): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (const e of entries) {
    if (e.kind !== 'text') {
      out.push(e);
      continue;
    }
    const chunks = splitLongText(e.text, maxLen);
    if (chunks.length === 1) {
      out.push(e);
      continue;
    }
    for (const c of chunks) {
      if (!c) {
        out.push({ text: '', kind: 'empty' });
      } else {
        out.push({ ...e, text: c });
      }
    }
  }
  return out;
}

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
  const liveOutputTimers = useRef<
    Map<ReturnType<typeof setTimeout>, { agent: AgentId; entry: DisplayEntry }>
  >(new Map());

  useEffect(() => {
    orchestrator.setConfig({ projectDir, claudePath, codexPath });
    orchestrator.setEnabledAgents(enabledAgentSet);
    orchestrator.bind({
      onAgentOutput: (agent: AgentId, line: OutputLine) => {
        if (stoppedRef.current) return;
        if (line.type === 'stdout') processTaskTags(agent, line.text);
        const rawEntries = outputToEntries(line);
        const liveChunkLen = getLiveChunkLen();
        const entries =
          line.type === 'stdout' ? splitEntriesForLive(rawEntries, liveChunkLen) : rawEntries;
        if (entries.length === 0) return;

        const hasLiveSplit =
          line.type === 'stdout' &&
          entries.length > 1 &&
          entries.some((e) => e.kind === 'text') &&
          (line.text.includes('\n') ||
            stripAnsi(line.text).length >= Math.max(LIVE_STREAM_MIN_TEXT_LEN, liveChunkLen + 20));
        if (hasLiveSplit) {
          const firstTextIdx = entries.findIndex((e) => e.kind === 'text');
          const immediateCount = firstTextIdx >= 0 ? firstTextIdx + 1 : 1;
          const immediateEntries = entries.slice(0, immediateCount);
          const delayedEntries = entries.slice(immediateCount);

          if (immediateEntries.length > 0) {
            enqueueOutput(agent, immediateEntries);
          }

          delayedEntries.forEach((entry, idx) => {
            const delay = (idx + 1) * LIVE_STREAM_STEP_MS;
            const timer = setTimeout(() => {
              const pending = liveOutputTimers.current.get(timer);
              if (!pending) return;
              liveOutputTimers.current.delete(timer);
              if (stoppedRef.current) return;
              enqueueOutput(pending.agent, [pending.entry]);
            }, delay);
            liveOutputTimers.current.set(timer, { agent, entry });
          });
          return;
        }
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
              let pendingLiveCount = 0;
              for (const item of liveOutputTimers.current.values()) {
                if (item.agent === agent) pendingLiveCount++;
              }
              const liveTailMs =
                pendingLiveCount > 0 ? pendingLiveCount * LIVE_STREAM_STEP_MS + 80 : 0;
              const closeDelay = Math.max(MSG_CLOSE_GRACE_MS, liveTailMs);
              const timer = setTimeout(() => {
                msgCloseTimers.current.delete(agent);
                const stillId = currentMsgRef.current.get(agent);
                if (stillId === currentId) {
                  const msg = chatMessagesMap.current.get(currentId);
                  if (msg) msg.status = 'done';
                  currentMsgRef.current.delete(agent);
                  lastEntryKind.current.delete(agent);
                }
              }, closeDelay);
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
        // Keep visual ordering deterministic:
        // 1) force pending live chunks from relay sender
        // 2) flush buffered output
        const relayFrom = msg.from as string;
        const sender =
          VALID_AGENT_IDS.has(relayFrom) ? (relayFrom as AgentId) : null;
        if (sender) {
          const pending: Array<{ agent: AgentId; entry: DisplayEntry }> = [];
          for (const [timer, item] of liveOutputTimers.current.entries()) {
            if (item.agent !== sender) continue;
            clearTimeout(timer);
            liveOutputTimers.current.delete(timer);
            pending.push(item);
          }
          for (const item of pending) {
            enqueueOutput(item.agent, [item.entry]);
          }
        }

        // 3) flush pending buffered output (e.g. Opus pre-tag text)
        if (flushTimer.current) {
          clearTimeout(flushTimer.current);
          flushTimer.current = null;
          flushBuffer();
        }
        const fromId = msg.from as string;
        const toId = msg.to as string;
        const isFromUser = fromId === 'user';
        const fromAgent: AgentId = VALID_AGENT_IDS.has(fromId) ? (fromId as AgentId) : 'opus';
        const toAgent: AgentId = VALID_AGENT_IDS.has(toId) ? (toId as AgentId) : 'opus';
        const fromColor = isFromUser ? THEME.userPrefix : agentHex(fromAgent);
        const toColor = agentHex(toAgent);
        const fromName = isFromUser ? 'You' : agentDisplayName(fromAgent);
        const toName = agentDisplayName(toAgent);
        const relayHeader = `${INDENT} ${chalk.hex(fromColor).bold(fromName)} ${chalk.dim('->')} ${chalk.hex(toColor).bold(toName)}`;
        const fakeOutputLine: OutputLine = {
          text: msg.content,
          timestamp: Date.now(),
          type: 'stdout',
        };
        const entries = outputToEntries(fakeOutputLine);
        const relayChalkColor = isFromUser ? ('cyan' as const) : agentChalkColor(fromAgent);
        const relayOut = entriesToAnsiOutputLines(entries, relayChalkColor);
        const block = ['', relayHeader, '', ...relayOut].join('\n');
        console.log(block);
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
    const capturedLiveOutputTimers = liveOutputTimers;
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
      for (const t of capturedLiveOutputTimers.current.keys()) {
        clearTimeout(t);
      }
      capturedLiveOutputTimers.current.clear();
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
