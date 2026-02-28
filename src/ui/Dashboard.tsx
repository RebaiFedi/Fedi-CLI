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
import { THEME, agentHex, agentDisplayName, agentChalkColor, agentIcon } from '../config/theme.js';
import { getMaxMessages, getFlushInterval, INDENT } from '../config/constants.js';
import { outputToEntries, extractTasks } from '../rendering/output-transform.js';
import { entriesToAnsiOutputLines } from '../rendering/ansi-renderer.js';
import { compactOutputLines } from '../rendering/compact.js';
import { ThinkingSpinner } from './ThinkingSpinner.js';
import { TodoPanel, type TodoItem } from './TodoPanel.js';
import { printWelcomeBanner } from './WelcomeBanner.js';
import { printSessionResume } from './SessionResumeView.js';
import { buildResumePrompt } from '../utils/session-manager.js';
import { printUserBubble } from './UserBubble.js';
// trace functions replaced by unified flog

// ── Props ───────────────────────────────────────────────────────────────────

interface DashboardProps {
  orchestrator: Orchestrator;
  projectDir: string;
  claudePath: string;
  codexPath: string;
  resumeSessionId?: string;
  enabledAgents?: AgentId[];
}

// ── Buffered entry ──────────────────────────────────────────────────────────

interface BufferedEntry {
  agent: AgentId;
  entries: DisplayEntry[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const AGENT_IDS = ['opus', 'sonnet', 'codex'] as const;
const VALID_AGENT_IDS = new Set<string>(['opus', 'sonnet', 'codex']);

// ── Dashboard ───────────────────────────────────────────────────────────────

export function Dashboard({
  orchestrator,
  projectDir,
  claudePath,
  codexPath,
  resumeSessionId,
  enabledAgents,
}: DashboardProps) {
  const { exit } = useApp();
  const maxMessagesRef = useRef(getMaxMessages());
  const flushInterval = getFlushInterval();

  const [agentStatuses, dispatchStatus] = useReducer(
    (state: Record<string, AgentStatus>, action: { agent: string; status: AgentStatus }) => ({
      ...state,
      [action.agent]: action.status,
    }),
    { opus: 'idle', sonnet: 'idle', codex: 'idle' } as Record<string, AgentStatus>,
  );
  const agentStatusesRef = useRef<Record<string, AgentStatus>>({ opus: 'idle', sonnet: 'idle', codex: 'idle' });
  const [agentErrors, setAgentErrors] = useState<Partial<Record<string, string>>>({});
  const [stopped, setStopped] = useState(false);
  const stoppedRef = useRef(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosHiddenAt, setTodosHiddenAt] = useState<number>(0);
  const [thinking, setThinking] = useState(false);
  const enabledAgentSet = useMemo(() => {
    const set = new Set<AgentId>();
    const source = enabledAgents ?? (AGENT_IDS as readonly AgentId[]);
    for (const agent of source) {
      if (agent === 'opus' || agent === 'sonnet' || agent === 'codex') set.add(agent);
    }
    set.add('opus');
    return set;
  }, [enabledAgents]);
  const visibleAgents = useMemo(
    () => AGENT_IDS.filter((id) => enabledAgentSet.has(id)),
    [enabledAgentSet],
  );

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
  // Grace period timers for closing agent messages — prevents duplicate headers
  // when an agent goes waiting→running in quick succession (multi-turn responses).
  const msgCloseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const outputBuffer = useRef<BufferedEntry[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const welcomePrinted = useRef(false);
  const lastPrintedAgent = useRef<AgentId | null>(null);
  const pendingActions = useRef<Map<AgentId, string[]>>(new Map());
  /** Track last action time per agent — for "still working" heartbeat display */
  const lastActionTime = useRef<Map<AgentId, number>>(new Map());
  const lastHeartbeatTime = useRef<Map<AgentId, number>>(new Map());
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
      // Show each action individually for full live visibility
      const summary: DisplayEntry[] = actions.map((a) => ({ text: a, kind: 'action' as const }));
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
        lastActionTime.current.set(agent, Date.now());
      }

      if (contentEntries.length === 0) {
        // Actions only — print every action live, no throttle
        const allActions = pendingActions.current.get(agent) ?? [];
        if (allActions.length > 0) {
          const icon = agentIcon(agent as import('../agents/types.js').AgentId);
          const label = chalk.hex(agentHex(agent))(`${icon} ${agentDisplayName(agent)}`);
          for (const action of allActions) {
            const short = action.length > 60 ? action.slice(0, 57) + '…' : action;
            outputLines.push(`${INDENT}${label} ${chalk.dim('·')} ${chalk.hex(THEME.actionText)(short)}`);
          }
          pendingActions.current.set(agent, []);
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
            const icon = agentIcon(agent as import('../agents/types.js').AgentId);
            const agName = chalk.hex(agentHex(agent)).bold(`${icon} ${agentDisplayName(agent)}`);
            const termW = process.stdout.columns || 80;
            const headerLine = `${INDENT}${agName}`;
            outputLines.push(headerLine);
            outputLines.push(`${INDENT}${chalk.hex(THEME.panelBorder)('─'.repeat(Math.min(termW - 4, 60)))}`);
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

      const icon = agentIcon(agent as import('../agents/types.js').AgentId);
      const name = chalk.hex(agentHex(agent)).bold(`${icon} ${agentDisplayName(agent)}`);
      const termW = process.stdout.columns || 80;
      outputLines.push(`${INDENT}${name}`);
      outputLines.push(`${INDENT}${chalk.hex(THEME.panelBorder)('─'.repeat(Math.min(termW - 4, 60)))}`);
      flushPendingActions(agent, agentColor);
      outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor));
      const last = contentEntries[contentEntries.length - 1];
      if (last) lastEntryKind.current.set(agent, last.kind);
    }

    // Heartbeat — show a working indicator for agents that are running but
    // haven't emitted any action in 5+ seconds (they're thinking/writing)
    const now = Date.now();
    for (const [agent, lastTime] of lastActionTime.current.entries()) {
      const status = agentStatusesRef.current[agent];
      if (status !== 'running') continue;
      const sinceLastAction = now - lastTime;
      const lastHb = lastHeartbeatTime.current.get(agent) ?? 0;
      // Show heartbeat every 5s if agent hasn't emitted actions in 5+ seconds
      if (sinceLastAction >= 5000 && now - lastHb >= 5000) {
        lastHeartbeatTime.current.set(agent, now);
        const icon = agentIcon(agent as import('../agents/types.js').AgentId);
        const label = chalk.hex(agentHex(agent))(`${icon} ${agentDisplayName(agent)}`);
        const elapsed = Math.floor(sinceLastAction / 1000);
        outputLines.push(`${INDENT}${label} ${chalk.hex(THEME.actionIcon)('·')} ${chalk.dim(`thinking… ${elapsed}s`)}`);
      }
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
      const isActionOnly = entries.length > 0 && entries.every((e) => e.kind === 'action');
      outputBuffer.current.push({ agent, entries });
      if (isFirstChunk) {
        // Flush immediately on first token for perceived speed
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flushBuffer, 0);
      } else if (isActionOnly) {
        // Actions (read, bash, etc.) — flush quickly for live visibility
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(flushBuffer, 80);
        }
      } else if (!flushTimer.current) {
        flushTimer.current = setTimeout(flushBuffer, flushInterval);
      }
    },
    [flushBuffer, flushInterval],
  );

  // Periodic heartbeat timer — triggers flushBuffer so the heartbeat
  // "writing report..." lines appear even when no agent is emitting output.
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    heartbeatTimer.current = setInterval(() => {
      // Only trigger if there are running agents with stale action times
      const now = Date.now();
      let needsFlush = false;
      for (const [, lastTime] of lastActionTime.current.entries()) {
        if (now - lastTime >= 5000) { needsFlush = true; break; }
      }
      if (needsFlush && !flushTimer.current) {
        flushTimer.current = setTimeout(flushBuffer, 0);
      }
    }, 3000);
    return () => { if (heartbeatTimer.current) clearInterval(heartbeatTimer.current); };
  }, [flushBuffer]);

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
      if (agent === 'sonnet' || agent === 'codex') {
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
    orchestrator.setEnabledAgents(enabledAgentSet);
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
          // Cancel grace-period timer — agent resumed, keep message open
          const graceTimer = msgCloseTimers.current.get(agent);
          if (graceTimer) { clearTimeout(graceTimer); msgCloseTimers.current.delete(agent); }
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
          // Clean up heartbeat tracking for finished agent
          lastActionTime.current.delete(agent);
          lastHeartbeatTime.current.delete(agent);
          // ── Flush batched [TASK:done] for sub-agents (claude/codex) ─────────
          // Apply all accumulated completions in a single setState call so the
          // progress bar jumps from 0/N straight to N/N (no intermediate steps).
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
            // Show each remaining action individually
            const summary: DisplayEntry[] = remaining.map((a) => ({ text: a, kind: 'action' as const }));
            const lines = entriesToAnsiOutputLines(summary, ac);
            if (lines.length > 0) console.log(compactOutputLines(lines).join('\n'));
            pendingActions.current.set(agent, []);
          }
          const currentId = currentMsgRef.current.get(agent);
          if (currentId) {
            if (status === 'waiting') {
              // Grace period: agent may resume (multi-turn). Close the message
              // after 3s if the agent doesn't go back to running.
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
                }
              }, 3000);
              msgCloseTimers.current.set(agent, timer);
            } else {
              // stopped / error / idle — close immediately
              const prevTimer = msgCloseTimers.current.get(agent);
              if (prevTimer) { clearTimeout(prevTimer); msgCloseTimers.current.delete(agent); }
              const msg = chatMessagesMap.current.get(currentId);
              if (msg) msg.status = 'done';
              currentMsgRef.current.delete(agent);
              lastEntryKind.current.delete(agent);
            }
          }
        }
      },
      onRelay: (msg: Message) => {
        flog.info('UI', `Relay: ${msg.from}->${msg.to}`);
        // Skip displaying relay messages with empty/garbage content
        const trimmedContent = msg.content.trim();
        if (!trimmedContent || trimmedContent.replace(/[`'".,;:\-–—\s]/g, '').length < 3) {
          flog.debug('UI', `Relay display skipped (empty/fragment): ${msg.from}->${msg.to}`);
          return;
        }
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
        const fromIcon = agentIcon(fromAgent);
        const toIcon = agentIcon(toAgent);
        const relayHeader = `${INDENT}${chalk.hex(fromColor).bold(`${fromIcon} ${fromName}`)} ${chalk.hex(THEME.muted)('→')} ${chalk.hex(toColor).bold(`${toIcon} ${toName}`)}`;
        const relayBody = `${INDENT}  ${chalk.hex('#94A3B8')(preview)}`;
        console.log(`\n${relayHeader}\n${relayBody}`);
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
    enabledAgentSet,
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
          orchestrator
            .restart(allMessage)
            .then(() => {
              orchestrator.sendToAllDirect(allMessage);
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
        { prefix: '@sonnet ', agent: 'sonnet' },
        { prefix: '@claude ', agent: 'sonnet' }, // alias retrocompat
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
          chalk.yellow(`  Agent @${targetAgent} est desactive. Agents actifs: ${[...enabledAgentSet].join(', ')}`),
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
          (cmd) =>
            cmd.startsWith(typed.slice(0, 2)) ||
            typed.startsWith(cmd.slice(0, 2)),
        );
        const suggestionText = suggestion ? ` Vous vouliez dire ${chalk.white(`@${suggestion}`)} ?` : '';
        console.log(
          chalk.yellow(`  Commande inconnue: @${typed}.${suggestionText}`),
        );
        console.log(
          chalk.dim('  Commandes disponibles: @opus, @codex, @claude, @sonnet, @tous, @all, @sessions'),
        );
        setThinking(false);
        return;
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
    [orchestrator, stopped, enabledAgentSet],
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
        {visibleAgents.map((id) => {
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
            <InputBar
              onSubmit={handleInput}
              projectDir={projectDir}
              placeholder={stopped ? 'Tapez pour relancer les agents...' : 'Message ou commande @agent'}
            />
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
