import React, { useState, useReducer, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import type {
  AgentId,
  AgentStatus,
  ChatMessage,
  DisplayEntry,
  Message,
  OutputLine,
} from '../agents/types.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { InputBar } from './InputBar.js';
import { flog } from '../utils/log.js';
import { THEME, agentHex, agentDisplayName, agentChalkColor } from '../config/theme.js';
import { getMaxMessages, getFlushInterval, INDENT } from '../config/constants.js';
import { outputToEntries, extractTasks } from '../rendering/output-transform.js';
import { entriesToAnsiOutputLines } from '../rendering/ansi-renderer.js';
import { compactOutputLines } from '../rendering/compact.js';
import { ThinkingSpinner } from './ThinkingSpinner.js';
import { TodoPanel, type TodoItem } from './TodoPanel.js';
import { printWelcomeBanner } from './WelcomeBanner.js';
import { printSessionResume, buildResumePrompt } from './SessionResumeView.js';
import { printUserBubble } from './UserBubble.js';
// trace functions replaced by unified flog

// ── Props ───────────────────────────────────────────────────────────────────

interface DashboardProps {
  orchestrator: Orchestrator;
  projectDir: string;
  claudePath: string;
  codexPath: string;
  resumeSessionId?: string;
}

// ── Buffered entry ──────────────────────────────────────────────────────────

interface BufferedEntry {
  agent: AgentId;
  entries: DisplayEntry[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const AGENT_IDS = ['opus', 'claude', 'codex'] as const;
const VALID_AGENT_IDS = new Set<string>(['opus', 'claude', 'codex']);

// ── Dashboard ───────────────────────────────────────────────────────────────

export function Dashboard({
  orchestrator,
  projectDir,
  claudePath,
  codexPath,
  resumeSessionId,
}: DashboardProps) {
  const { exit } = useApp();
  const maxMessagesRef = useRef(getMaxMessages());
  const flushInterval = getFlushInterval();

  const [agentStatuses, dispatchStatus] = useReducer(
    (state: Record<string, AgentStatus>, action: { agent: string; status: AgentStatus }) => ({
      ...state,
      [action.agent]: action.status,
    }),
    { opus: 'idle', claude: 'idle', codex: 'idle' } as Record<string, AgentStatus>,
  );
  const agentStatusesRef = useRef<Record<string, AgentStatus>>({ opus: 'idle', claude: 'idle', codex: 'idle' });
  const [agentErrors, setAgentErrors] = useState<Partial<Record<string, string>>>({});
  const [stopped, setStopped] = useState(false);
  const stoppedRef = useRef(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosHiddenAt, setTodosHiddenAt] = useState<number>(0);
  const [thinking, setThinking] = useState(false);

  // Schedule auto-hide when all todos are done; reset when new todos arrive
  const todosAllDone = useMemo(() => todos.length > 0 && todos.every((t) => t.done), [todos]);
  useEffect(() => {
    if (!todosAllDone) return;
    const timer = setTimeout(() => setTodosHiddenAt(Date.now()), 1500);
    return () => clearTimeout(timer);
  }, [todosAllDone]);

  const todosVisible = todos.length > 0 && !(todosAllDone && todosHiddenAt > 0);

  const currentMsgRef = useRef<Map<string, string>>(new Map());
  const lastEntryKind = useRef<Map<string, DisplayEntry['kind']>>(new Map());
  const chatMessagesMap = useRef<Map<string, ChatMessage>>(new Map());
  const outputBuffer = useRef<BufferedEntry[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const welcomePrinted = useRef(false);
  const lastPrintedAgent = useRef<AgentId | null>(null);
  const pendingActions = useRef<Map<AgentId, string[]>>(new Map());
  /** Last time we printed an action summary for each agent — throttle to avoid spam */
  const lastActionPrint = useRef<Map<AgentId, number>>(new Map());
  /**
   * Buffer of [TASK:done] tags emitted by agent sub-agents (claude/codex) during
   * their current turn. We accumulate them and apply all at once when the agent
   * finishes (idle/waiting/stopped) so the progress bar jumps 0/N → N/N in one
   * render instead of stepping 1/N, 2/N … N/N.
   */
  const pendingAgentDones = useRef<Map<AgentId, string[]>>(new Map());
  /** Debounce timer for clearing the thinking spinner (avoids flicker between agent transitions) */
  const thinkingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Prevents double-shutdown on repeated SIGINT — must be a ref to survive re-renders */
  const exitInProgress = useRef(false);

  // Print welcome banner once at mount
  useEffect(() => {
    if (welcomePrinted.current) return;
    welcomePrinted.current = true;
    printWelcomeBanner(projectDir);
  }, [projectDir]);

  // Fix Ink resize ghost: clear stale output when terminal width changes (debounced)
  const { stdout } = useStdout();
  const lastWidth = useRef(stdout.columns || 80);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onResize = () => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        resizeTimer.current = null;
        const newWidth = stdout.columns || 80;
        if (newWidth !== lastWidth.current) {
          stdout.write('\x1b[J');
          lastWidth.current = newWidth;
        }
      }, 100);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, [stdout]);

  const flushBuffer = useCallback(() => {
    flushTimer.current = null;
    const items = outputBuffer.current.splice(0);
    if (items.length === 0) return;

    // Collect ALL output into a single string, then emit ONE console.log.
    // Multiple console.log calls while Ink is rendering cause ghost/duplicate
    // lines because each call triggers Ink to erase + redraw its dynamic zone.
    const outputLines: string[] = [];

    const flushPendingActions = (agent: AgentId, agentColor: 'green' | 'yellow' | 'magenta' | 'cyan') => {
      const actions = pendingActions.current.get(agent);
      if (!actions || actions.length === 0) return;
      const summary: DisplayEntry[] = [];
      if (actions.length <= 2) {
        for (const a of actions) summary.push({ text: a, kind: 'action' });
      } else {
        summary.push({
          text: `${actions[actions.length - 1]} (+${actions.length - 1} more)`,
          kind: 'action',
        });
      }
      outputLines.push(...entriesToAnsiOutputLines(summary, agentColor));
      pendingActions.current.set(agent, []);
    };

    for (const { agent, entries } of items) {
      if (entries.length === 0) continue;
      const agentColor = agentChalkColor(agent);

      const contentEntries: DisplayEntry[] = [];
      const newActions: string[] = [];
      for (const e of entries) {
        if (e.kind === 'action') {
          newActions.push(e.text);
        } else {
          contentEntries.push(e);
        }
      }

      if (newActions.length > 0) {
        const existing = pendingActions.current.get(agent) ?? [];
        const combined = [...existing, ...newActions];
        // Cap at 100 actions per agent to prevent memory leak
        pendingActions.current.set(agent, combined.length > 100 ? combined.slice(-100) : combined);
      }

      if (contentEntries.length === 0) {
        // Actions only — print compact summary (throttled: max once per 1s per agent)
        const allActions = pendingActions.current.get(agent) ?? [];
        const now = Date.now();
        const lastPrint = lastActionPrint.current.get(agent) ?? 0;
        if (allActions.length > 0 && now - lastPrint >= 1000) {
          lastActionPrint.current.set(agent, now);
          const last = allActions[allActions.length - 1];
          const short = last.length > 50 ? last.slice(0, 47) + '...' : last;
          const count = allActions.length > 1 ? chalk.dim(` (+${allActions.length - 1})`) : '';
          const label = chalk.hex(agentHex(agent))(agentDisplayName(agent));
          outputLines.push(`${INDENT}${label} ${chalk.dim(short)}${count}`);
        }
        continue;
      }

      const prevKind = lastEntryKind.current.get(agent);
      const currentId = currentMsgRef.current.get(agent);
      if (currentId) {
        const msg = chatMessagesMap.current.get(currentId);
        if (msg) {
          const agentSwitched = lastPrintedAgent.current && lastPrintedAgent.current !== agent;
          if (agentSwitched) {
            outputLines.push('');
            const agName = chalk.hex(agentHex(agent)).bold(agentDisplayName(agent));
            outputLines.push(`${INDENT}${agName}`);
          }
          lastPrintedAgent.current = agent;
          msg.lines.push(...entries);
          flushPendingActions(agent, agentColor);
          outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor, prevKind));
          const last = contentEntries[contentEntries.length - 1];
          if (last) lastEntryKind.current.set(agent, last.kind);
          continue;
        }
      }

      if (lastPrintedAgent.current && lastPrintedAgent.current !== agent) {
        outputLines.push('');
      }
      lastPrintedAgent.current = agent;

      const id = randomUUID();
      currentMsgRef.current.set(agent, id);
      chatMessagesMap.current.set(id, {
        id,
        agent,
        lines: [...entries],
        timestamp: Date.now(),
        status: 'streaming',
      });
      if (chatMessagesMap.current.size > maxMessagesRef.current) {
        const keys = [...chatMessagesMap.current.keys()];
        for (const k of keys.slice(0, chatMessagesMap.current.size - maxMessagesRef.current)) {
          chatMessagesMap.current.delete(k);
        }
      }

      const name = chalk.hex(agentHex(agent)).bold(agentDisplayName(agent));
      outputLines.push(`${INDENT}${name}`);
      flushPendingActions(agent, agentColor);
      outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor));
      const last = contentEntries[contentEntries.length - 1];
      if (last) lastEntryKind.current.set(agent, last.kind);
    }

    if (outputLines.length > 0) {
      const final = compactOutputLines(outputLines).join('\n');
      flog.debug('UI', 'Output displayed', { preview: final.slice(0, 120) });
      // Single console.log call — Ink erases+redraws its zone only once
      console.log(final);
    }
  }, []);

  const enqueueOutput = useCallback(
    (agent: AgentId, entries: DisplayEntry[]) => {
      const isFirstChunk = !currentMsgRef.current.has(agent);
      outputBuffer.current.push({ agent, entries });
      if (isFirstChunk) {
        // Flush immediately on first token for perceived speed
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flushBuffer, 0);
      } else if (!flushTimer.current) {
        flushTimer.current = setTimeout(flushBuffer, flushInterval);
      }
    },
    [flushBuffer, flushInterval],
  );

  useInput((_input, key) => {
    if (key.escape && !stopped) {
      setStopped(true);
      stoppedRef.current = true;
      setThinking(false);
      // Clear any pending thinking timer
      if (thinkingClearTimer.current) {
        clearTimeout(thinkingClearTimer.current);
        thinkingClearTimer.current = null;
      }
      // Flush any pending output
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushBuffer();
      }
      // Stop all agents — fire-and-forget but agents are killed immediately
      orchestrator.stop().catch((err) => flog.error('UI', `Stop error: ${err}`));
      console.log(
        '\n' + chalk.dim('  Agents arretes. Tapez un message pour relancer, ou Ctrl+C pour quitter.'),
      );
    }
  });

  /**
   * Apply a list of done-texts to the current todos list (pure updater).
   * Used both for immediate (opus/user) and batched (claude/codex) completion.
   */
  const applyDones = useCallback((dones: string[]) => {
    if (dones.length === 0) return;
    setTodos((prev) => {
      let updated = [...prev];
      for (const done of dones) {
        const lower = done.toLowerCase();
        // 1. Exact substring match (done text inside todo text)
        let idx = updated.findIndex((t) => !t.done && t.text.toLowerCase().includes(lower));
        // 2. Reverse match (todo text inside done text)
        if (idx === -1) {
          idx = updated.findIndex((t) => !t.done && lower.includes(t.text.toLowerCase()));
        }
        // 3. Fuzzy word match (at least 1 significant word overlap for short texts, 2 for longer)
        if (idx === -1) {
          const doneWords = lower.split(/\s+/).filter((w) => w.length > 3);
          const threshold = doneWords.length <= 2 ? 1 : 2;
          idx = updated.findIndex((t) => {
            if (t.done) return false;
            const todoLower = t.text.toLowerCase();
            const matchCount = doneWords.filter((w) => todoLower.includes(w)).length;
            return matchCount >= threshold;
          });
        }
        if (idx !== -1) updated[idx] = { ...updated[idx]!, done: true };
      }
      return updated;
    });
  }, []);

  const processTaskTags = useCallback((agent: AgentId, text: string) => {
    const { adds, dones } = extractTasks(text);
    if (adds.length === 0 && dones.length === 0) return;

    // ── Adds: always immediate (any agent) ───────────────────────────────────
    if (adds.length > 0) {
      setTodos((prev) => {
        let updated = [...prev];
        let hasNewItems = false;
        for (const add of adds) {
          if (!updated.some((t) => t.text.toLowerCase() === add.toLowerCase())) {
            updated.push({ id: randomUUID(), text: add, done: false, agent });
            hasNewItems = true;
          }
        }
        if (hasNewItems) setTodosHiddenAt(0);
        return updated;
      });
    }

    // ── Dones: batch for sub-agents (claude/codex), immediate for opus/user ──
    if (dones.length > 0) {
      if (agent === 'claude' || agent === 'codex') {
        // Accumulate — will be flushed as a single update when agent finishes
        const existing = pendingAgentDones.current.get(agent) ?? [];
        pendingAgentDones.current.set(agent, [...existing, ...dones]);
      } else {
        // Opus or user-triggered: apply immediately
        applyDones(dones);
      }
    }
  }, [applyDones]);

  useEffect(() => {
    orchestrator.setConfig({ projectDir, claudePath, codexPath });
    orchestrator.bind({
      onAgentOutput: (agent: AgentId, line: OutputLine) => {
        if (line.type === 'stdout') processTaskTags(agent, line.text);
        const entries = outputToEntries(line);
        if (entries.length === 0) return;
        enqueueOutput(agent, entries);
      },
      onAgentStatus: (agent: AgentId, status: AgentStatus) => {
        // Update pill status even when stopped (so pills go grey)
        dispatchStatus({ agent, status });
        agentStatusesRef.current = { ...agentStatusesRef.current, [agent]: status };

        // Update agentErrors
        if (status === 'error') {
          setAgentErrors((prev) => {
            if (prev[agent] === 'error') return prev;
            return { ...prev, [agent]: `Agent ${agent} en erreur` };
          });
        } else if (status === 'running' || status === 'idle' || status === 'waiting') {
          setAgentErrors((prev) => {
            if (!(agent in prev)) return prev;
            const n = { ...prev };
            delete n[agent];
            return n;
          });
        }

        // Don't re-trigger spinner when we are stopped
        if (stoppedRef.current) return;

        if (status === 'running') {
          if (thinkingClearTimer.current) {
            clearTimeout(thinkingClearTimer.current);
            thinkingClearTimer.current = null;
          }
          setThinking(true);
        } else {
          const currentStatuses = { ...agentStatusesRef.current, [agent]: status };
          const anyRunningNow = Object.values(currentStatuses).some((s) => s === 'running');
          // Keep spinner active if Opus still has pending delegates (agents answered
          // but Opus hasn't received the combined report yet — app would look frozen)
          const pendingDelegates = orchestrator.hasPendingDelegates;
          if (!anyRunningNow && !pendingDelegates && !thinkingClearTimer.current) {
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
          // ── Flush batched [TASK:done] for sub-agents (claude/codex) ─────────
          // Apply all accumulated completions in a single setState call so the
          // progress bar jumps from 0/N straight to N/N (no intermediate steps).
          if (agent === 'claude' || agent === 'codex') {
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
            const summary: DisplayEntry[] =
              remaining.length <= 2
                ? remaining.map((a) => ({ text: a, kind: 'action' as const }))
                : [
                    {
                      text: `${remaining[remaining.length - 1]} (+${remaining.length - 1} more)`,
                      kind: 'action' as const,
                    },
                  ];
            const lines = entriesToAnsiOutputLines(summary, ac);
            if (lines.length > 0) console.log(compactOutputLines(lines).join('\n'));
            pendingActions.current.set(agent, []);
          }
          const currentId = currentMsgRef.current.get(agent);
          if (currentId) {
            const msg = chatMessagesMap.current.get(currentId);
            if (msg) msg.status = 'done';
            currentMsgRef.current.delete(agent);
            lastEntryKind.current.delete(agent);
          }
        }
      },
      onRelay: (msg: Message) => {
        flog.info('UI', `Relay: ${msg.from}->${msg.to}`);
        // Show cross-talk and delegation messages to the user
        const fromId = msg.from as string;
        const toId = msg.to as string;
        // Validate agent IDs before using theme functions
        const validAgents = VALID_AGENT_IDS;
        const fromAgent: AgentId = validAgents.has(fromId) ? fromId as AgentId : 'opus';
        const toAgent: AgentId = validAgents.has(toId) ? toId as AgentId : 'opus';
        const fromName = agentDisplayName(fromAgent);
        const toName = agentDisplayName(toAgent);
        const fromColor = agentHex(fromAgent);
        const toColor = agentHex(toAgent);
        const preview = msg.content.length > 120
          ? msg.content.slice(0, 117) + '...'
          : msg.content;
        const relayLine =
          `${INDENT}${chalk.hex(fromColor).bold(fromName)} ${chalk.dim('\u2192')} ${chalk.hex(toColor).bold(toName)}${chalk.dim(':')} ${chalk.hex('#CBD5E1')(preview)}`;
        console.log(`\n${relayLine}`);
      },
      onRelayBlocked: (msg: Message) => {
        flog.info('UI', `Relay blocked: ${msg.from}->${msg.to}`);
      },
    });

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
            orchestrator
              .startWithTask(resumePrompt)
              .catch((err) => {
                flog.error('UI',`[DASHBOARD] Resume error: ${err}`);
                if (stoppedRef.current) setThinking(false);
              });
          } else {
            console.log(chalk.red(`  Session ${resumeSessionId} non trouvee ou corrompue.`));
          }
        } else {
          console.log(chalk.red(`  Session ${resumeSessionId} non trouvee.`));
          console.log(chalk.dim('  Utilisez: fedi --sessions pour voir la liste.'));
        }
      })().catch((err) => flog.error('UI',`[DASHBOARD] Session resume error: ${err}`));
    }

    const handleExit = () => {
      if (exitInProgress.current) {
        // Second signal = force quit
        flog.warn('UI', 'Force exit requested');
        process.exit(1);
      }
      // Warn if agents are still active
      const activeAgents = Object.entries(agentStatusesRef.current)
        .filter(([, s]) => s === 'running')
        .map(([a]) => a);
      if (activeAgents.length > 0 && !stoppedRef.current) {
        exitInProgress.current = true;
        console.log(chalk.yellow(`\n  Agents actifs (${activeAgents.join(', ')}) — Ctrl+C encore pour forcer.`));
      } else {
        exitInProgress.current = true;
      }
      flog.info('UI', 'Graceful shutdown initiated...');
      // Flush pending output before stopping
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushBuffer();
      }
      orchestrator.stop()
        .catch((err) => flog.error('UI', `Shutdown error: ${err}`))
        .finally(() => {
          flog.info('UI', 'Shutdown complete');
          exit();
        });
    };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
    return () => {
      process.off('SIGINT', handleExit);
      process.off('SIGTERM', handleExit);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (thinkingClearTimer.current) clearTimeout(thinkingClearTimer.current);
    };
  }, [
    orchestrator,
    exit,
    projectDir,
    claudePath,
    codexPath,
    resumeSessionId,
    processTaskTags,
    enqueueOutput,
    flushBuffer,
    applyDones,
  ]);

  const handleInput = useCallback(
    (text: string) => {
      flog.info('UI', `User input: ${text.slice(0, 100)}`);
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
      if (text.trim() === '@sessions') {
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
                `    ${chalk.dim(dateStr)} ${chalk.dim(timeStr)}  ${chalk.hex(THEME.claude)(shortId)}  ${status}  ${chalk.hex(THEME.text)(task)}`,
              );
            }
            sessionLines.push('', chalk.dim('    Voir en detail: fedi --view <id>'), '');
            console.log(sessionLines.join('\n'));
          }
        })().catch((err) => flog.error('UI',`[DASHBOARD] Sessions list error: ${err}`)).finally(() => setThinking(false));
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
          setTodos([]);
          pendingAgentDones.current.clear();
          if (isRestart) console.log('Redemarrage...');
          // Pass the real message as Opus startup task so Opus also participates
          orchestrator
            .restart(`[FROM:USER] @tous ${allMessage}`)
            .then(() => {
              // Also send directly to claude and codex
              orchestrator.sendToAgent('claude', allMessage);
              orchestrator.sendToAgent('codex', allMessage);
            })
            .catch((err) => flog.error('UI',`[DASHBOARD] Start error: ${err}`));
        } else {
          orchestrator.sendToAllDirect(allMessage);
        }
        return;
      }

      // Parse @agent commands — use indexOf(' ') to avoid hardcoded offsets
      let targetAgent: AgentId | null = null;
      let agentMessage = text;
      const agentPrefixes: { prefix: string; agent: AgentId }[] = [
        { prefix: '@opus ', agent: 'opus' },
        { prefix: '@codex ', agent: 'codex' },
        { prefix: '@claude ', agent: 'claude' },
        { prefix: '@sonnet ', agent: 'claude' },
      ];
      for (const { prefix, agent } of agentPrefixes) {
        if (text.toLowerCase().startsWith(prefix)) {
          targetAgent = agent;
          agentMessage = text.slice(prefix.length);
          break;
        }
      }

      if (!orchestrator.isStarted || stopped) {
        const isRestart = stopped;
        setStopped(false);
        stoppedRef.current = false;
        setTodos([]);
        pendingAgentDones.current.clear();
        if (targetAgent && targetAgent !== 'opus') {
          const agentNames: Record<string, string> = { claude: 'Sonnet', codex: 'Codex' };
          if (isRestart) console.log('Redemarrage...');
          // Pre-signal direct mode BEFORE restart so Opus relay to this agent is blocked
          orchestrator.setDirectMode(targetAgent);
          orchestrator
            .restart(
              `Le user parle directement a ${agentNames[targetAgent] ?? targetAgent} via @${targetAgent}. NE FAIS RIEN. N'execute AUCUNE tache. Attends en silence.`,
            )
            .then(() => {
              orchestrator.sendToAgent(targetAgent!, agentMessage);
            })
            .catch((err) => flog.error('UI',`[DASHBOARD] Start error: ${err}`));
        } else {
          if (isRestart) console.log('Redemarrage...');
          orchestrator
            .restart(targetAgent === 'opus' ? agentMessage : text)
            .catch((err) => flog.error('UI',`[DASHBOARD] Start error: ${err}`));
        }
        return;
      }

      if (targetAgent) {
        orchestrator.sendToAgent(targetAgent, agentMessage);
        return;
      }
      orchestrator.sendUserMessage(text);
    },
    [orchestrator, stopped],
  );

  const anyRunning = useMemo(
    () => Object.values(agentStatuses).some((s) => s === 'running'),
    [agentStatuses],
  );

  return (
    <Box flexDirection="column">
      <Text> </Text>
      {thinking ? <ThinkingSpinner /> : <Text> </Text>}
      <Box paddingX={2} gap={2}>
        {AGENT_IDS.map((id) => {
          const s = agentStatuses[id];
          const color =
            s === 'running' ? THEME[id] : s === 'error' ? 'red' : THEME.muted;
          const icon = s === 'running' ? '●' : s === 'error' ? '✖' : '○';
          return (
            <Text key={id} color={color}>
              {icon} {agentDisplayName(id)}
            </Text>
          );
        })}
      </Box>
      {Object.keys(agentErrors).length > 0 && (
        <Box paddingX={2} flexDirection="column">
          {Object.entries(agentErrors).map(([agent, msg]) => (
            <Text key={agent} color="red">
              {'  ⚠ '}{msg}
            </Text>
          ))}
        </Box>
      )}
      {todosVisible && <TodoPanel items={todos} />}
      <Box width="100%" flexGrow={1}>
        <Box
          width="100%"
          flexGrow={1}
          paddingY={0}
          borderStyle="round"
          borderColor={anyRunning ? THEME.opus : THEME.panelBorder}
        >
          <Text color={THEME.text}>{' \u276F '}</Text>
          <Box flexGrow={1}>
            <InputBar onSubmit={handleInput} placeholder={stopped ? "Tapez pour relancer les agents..." : "Message or @agent command"} />
          </Box>
        </Box>
      </Box>
      <Box paddingX={2} paddingTop={0}>
        <Text>
          <Text dimColor>{'esc '}</Text>
          <Text color={THEME.muted}>{'stop'}</Text>
          <Text dimColor>{'  \u00B7  '}</Text>
          <Text dimColor>{'^C '}</Text>
          <Text color={THEME.muted}>{'quit'}</Text>
        </Text>
      </Box>
    </Box>
  );
}
