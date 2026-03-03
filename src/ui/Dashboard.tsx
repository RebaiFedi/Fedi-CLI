import React, { useState, useReducer, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import type { AgentId, AgentStatus, ChatMessage, DisplayEntry } from '../agents/types.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { InputBar } from './InputBar.js';
import { flog } from '../utils/log.js';
import stripAnsi from 'strip-ansi';
import { THEME, agentHex, agentDisplayName, agentChalkColor } from '../config/theme.js';
import { getMaxMessages, getFlushInterval, INDENT } from '../config/constants.js';
import { extractTasks } from '../rendering/output-transform.js';
import { entriesToAnsiOutputLines } from '../rendering/ansi-renderer.js';
import { compactOutputLines } from '../rendering/compact.js';
import { ThinkingSpinner } from './ThinkingSpinner.js';
import { TodoPanel, type TodoItem } from './TodoPanel.js';
import { printWelcomeBanner } from './WelcomeBanner.js';
import { printSessionResume } from './SessionResumeView.js';
import { buildResumePrompt } from '../utils/session-manager.js';
import { SlashMenu } from './SlashMenu.js';
import { useSlashCommands } from './useSlashCommands.js';
import { useInputHandler } from './useInputHandler.js';
import { useOrchestratorBinding } from './useOrchestratorBinding.js';

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
  const agentStatusesRef = useRef<Record<string, AgentStatus>>({
    opus: 'idle',
    sonnet: 'idle',
    codex: 'idle',
  });
  const [agentErrors, setAgentErrors] = useState<Partial<Record<string, string>>>({});
  const [stopped, setStopped] = useState(false);
  const stoppedRef = useRef(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosHiddenAt, setTodosHiddenAt] = useState<number>(0);
  const [thinking, setThinking] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
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
  const msgCloseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const outputBuffer = useRef<BufferedEntry[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const welcomePrinted = useRef(false);
  const lastPrintedAgent = useRef<AgentId | null>(null);
  const pendingActions = useRef<Map<AgentId, string[]>>(new Map());
  const lastActionTime = useRef<Map<AgentId, number>>(new Map());
  const lastHeartbeatTime = useRef<Map<AgentId, number>>(new Map());
  const pendingAgentDones = useRef<Map<AgentId, string[]>>(new Map());
  const thinkingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // ── Output buffer + flush ─────────────────────────────────────────────────

  const flushBuffer = useCallback(() => {
    flushTimer.current = null;
    const items = outputBuffer.current.splice(0);
    if (items.length === 0) return;

    const outputLines: string[] = [];
    const mergeMarkerHeaders = (lines: string[]): string[] => {
      const merged: string[] = [];
      const isAgentHeader = (value: string) => /^(Opus|Sonnet|Codex):$/.test(value);
      const isToolLead = (value: string) =>
        /^(Exec|Read|Write|Edit|Create|Delete|Search|Grep|List|Fetch|Agent|Todo)\b/i.test(value);
      for (let i = 0; i < lines.length; i++) {
        const current = lines[i] ?? '';
        const currentTrimmed = stripAnsi(current).trim();
        const next = lines[i + 1];
        if (
          isAgentHeader(currentTrimmed) &&
          typeof next === 'string'
        ) {
          const prefixWithIndent = current;
          const continuationIndent = ' '.repeat(stripAnsi(prefixWithIndent).length + 1);
          let firstContentIdx = i + 1;
          while (
            firstContentIdx < lines.length &&
            stripAnsi(lines[firstContentIdx] ?? '').trim() === ''
          ) {
            firstContentIdx++;
          }
          if (
            firstContentIdx >= lines.length ||
            isAgentHeader(stripAnsi(lines[firstContentIdx] ?? '').trim())
          ) {
            merged.push(current);
            continue;
          }
          const firstContent = lines[firstContentIdx] ?? '';
          const firstContentTrimmed = stripAnsi(firstContent).trim();
          // Keep agent header on its own line for tool/action streams.
          if (isToolLead(firstContentTrimmed)) {
            merged.push(current);
            continue;
          }
          merged.push(`${prefixWithIndent} ${firstContent.replace(/^\s+/, '')}`);
          let j = firstContentIdx + 1;
          while (j < lines.length) {
            const follow = lines[j] ?? '';
            const followTrimmed = stripAnsi(follow).trim();
            if (followTrimmed === '' || isAgentHeader(followTrimmed)) break;
            merged.push(`${continuationIndent}${follow.replace(/^\s+/, '')}`);
            j++;
          }
          i = j - 1;
          continue;
        }
        merged.push(current);
      }
      return merged;
    };
    const pushGap = () => {
      if (outputLines.length === 0) return;
      const last = stripAnsi(outputLines[outputLines.length - 1]).trim();
      if (last !== '') outputLines.push('');
    };

    const flushPendingActions = (
      agent: AgentId,
      agentColor: 'green' | 'yellow' | 'magenta' | 'cyan',
    ) => {
      const actions = pendingActions.current.get(agent);
      if (!actions || actions.length === 0) return;
      const summary: DisplayEntry[] = actions.map((a) => ({ text: a, kind: 'action' as const }));
      outputLines.push(...entriesToAnsiOutputLines(summary, agentColor));
      pendingActions.current.set(agent, []);
    };

      const emitAgentHeader = (agent: AgentId, opts?: { separate?: boolean }) => {
        const prefix = chalk.hex(agentHex(agent)).bold(`${agentDisplayName(agent)}:`);
        const headerIndent = `${INDENT} `;
        if (lastPrintedAgent.current && (opts?.separate || lastPrintedAgent.current !== agent)) {
          // Preserve one visual blank line before a new agent/message header,
          // including when this flush starts right after a previous flush.
          if (outputLines.length === 0) {
            outputLines.push('');
          } else {
            pushGap();
          }
        }
        outputLines.push(`${headerIndent}${prefix}`);
        lastPrintedAgent.current = agent;
      };

    for (const { agent, entries } of items) {
      if (entries.length === 0) continue;
      const agentColor = agentChalkColor(agent);

      const contentEntries: DisplayEntry[] = [];
      const newActions: string[] = [];
      const inlineToolEntries: DisplayEntry[] = [];
      const hasOpenMsg = !!currentMsgRef.current.get(agent);
      for (const e of entries) {
        if (e.kind === 'action') {
          newActions.push(e.text);
        } else if (
          !hasOpenMsg &&
          (e.kind === 'tool-header' || e.kind === 'diff-old' || e.kind === 'diff-new')
        ) {
          inlineToolEntries.push(e);
        } else {
          contentEntries.push(e);
        }
      }

      if (newActions.length > 0) {
        const existing = pendingActions.current.get(agent) ?? [];
        const combined = [...existing, ...newActions];
        pendingActions.current.set(agent, combined.length > 100 ? combined.slice(-100) : combined);
        lastActionTime.current.set(agent, Date.now());
      }

      // ── Actions only (no content, no tool entries) ──────────────────────────
      if (contentEntries.length === 0 && inlineToolEntries.length === 0) {
        const allActions = pendingActions.current.get(agent) ?? [];
        if (allActions.length > 0) {
          if (lastPrintedAgent.current !== agent) {
            emitAgentHeader(agent);
          }
          const rendered = entriesToAnsiOutputLines(
            allActions.map((a) => ({ text: a, kind: 'action' as const })),
            agentColor,
          );
          outputLines.push(...rendered);
          pendingActions.current.set(agent, []);
        }
        continue;
      }

      // ── Inline tool entries (tool-header/diff without open message) ─────────
      if (inlineToolEntries.length > 0 && contentEntries.length === 0) {
        if (lastPrintedAgent.current !== agent) {
          emitAgentHeader(agent);
        }
        const allActions = pendingActions.current.get(agent) ?? [];
        if (allActions.length > 0) {
          const rendered = entriesToAnsiOutputLines(
            allActions.map((a) => ({ text: a, kind: 'action' as const })),
            agentColor,
          );
          outputLines.push(...rendered);
          pendingActions.current.set(agent, []);
        }
        outputLines.push(...entriesToAnsiOutputLines(inlineToolEntries, agentColor));
        lastActionTime.current.set(agent, Date.now());
        continue;
      }

      // ── Content entries (text, headings, code, etc.) ────────────────────────
      const prevKind = lastEntryKind.current.get(agent);
      const currentId = currentMsgRef.current.get(agent);
      if (currentId) {
        const msg = chatMessagesMap.current.get(currentId);
        if (msg) {
          if (lastPrintedAgent.current !== agent) {
            emitAgentHeader(agent);
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

      // Create new message block with header
      emitAgentHeader(agent, { separate: true });

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

      flushPendingActions(agent, agentColor);
      outputLines.push(...entriesToAnsiOutputLines(contentEntries, agentColor));
      const last = contentEntries[contentEntries.length - 1];
      if (last) lastEntryKind.current.set(agent, last.kind);
    }

    // Heartbeat — working indicator for agents with stale action times
    const now = Date.now();
    for (const [agent, lastTime] of lastActionTime.current.entries()) {
      const status = agentStatusesRef.current[agent];
      if (status !== 'running') continue;
      const sinceLastAction = now - lastTime;
      const lastHb = lastHeartbeatTime.current.get(agent) ?? 0;
      if (sinceLastAction >= 5000 && now - lastHb >= 5000) {
        lastHeartbeatTime.current.set(agent, now);
        const hbLabel = chalk.hex(agentHex(agent)).bold(`${agentDisplayName(agent)}:`);
        const elapsed = Math.floor(sinceLastAction / 1000);
        if (lastPrintedAgent.current && lastPrintedAgent.current !== agent) {
          pushGap();
        }
        outputLines.push(`${INDENT} ${hbLabel} ${chalk.dim(`thinking… ${elapsed}s`)}`);
        lastPrintedAgent.current = agent as AgentId;
      }
    }

    const compacted = compactOutputLines(mergeMarkerHeaders(outputLines));
    while (
      compacted.length > 1 &&
      stripAnsi(compacted[0]).trim() === '' &&
      stripAnsi(compacted[1]).trim() === ''
    ) {
      compacted.shift();
    }
    if (
      !lastPrintedAgent.current &&
      compacted.length > 0 &&
      stripAnsi(compacted[0]).trim() === ''
    ) {
      compacted.shift();
    }

    if (compacted.length > 0) {
      const final = compacted.join('\n');
      flog.debug('UI', 'Output displayed', { preview: final.slice(0, 120) });
      console.log(final);
    }
  }, []);

  const enqueueOutput = useCallback(
    (agent: AgentId, entries: DisplayEntry[]) => {
      const isFirstChunk = !currentMsgRef.current.has(agent);
      const isActionLike =
        entries.length > 0 &&
        entries.every(
          (e) =>
            e.kind === 'action' ||
            e.kind === 'tool-header' ||
            e.kind === 'diff-old' ||
            e.kind === 'diff-new',
        );
      // Text content → fast flush for streaming effect
      const isTextContent =
        entries.length > 0 &&
        entries.some(
          (e) => e.kind === 'text' || e.kind === 'heading' || e.kind === 'code',
        );
      outputBuffer.current.push({ agent, entries });
      if (isFirstChunk) {
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flushBuffer, 0);
      } else if (isTextContent) {
        // Flush text content rapidly for streaming effect
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(flushBuffer, 16);
        }
      } else if (isActionLike) {
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(flushBuffer, 80);
        }
      } else if (!flushTimer.current) {
        flushTimer.current = setTimeout(flushBuffer, flushInterval);
      }
    },
    [flushBuffer, flushInterval],
  );

  // Periodic heartbeat timer
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    heartbeatTimer.current = setInterval(() => {
      const now = Date.now();
      let needsFlush = false;
      for (const [, lastTime] of lastActionTime.current.entries()) {
        if (now - lastTime >= 5000) {
          needsFlush = true;
          break;
        }
      }
      if (needsFlush && !flushTimer.current) {
        flushTimer.current = setTimeout(flushBuffer, 0);
      }
    }, 3000);
    return () => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    };
  }, [flushBuffer]);

  // ── Escape key handler ──────────────────────────────────────────────────────

  useInput((_input, key) => {
    if (key.escape && !stopped) {
      setStopped(true);
      stoppedRef.current = true;
      setThinking(false);
      if (thinkingClearTimer.current) {
        clearTimeout(thinkingClearTimer.current);
        thinkingClearTimer.current = null;
      }
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushBuffer();
      }
      orchestrator.stop().catch((err) => flog.error('UI', `Stop error: ${err}`));
      console.log(
        '\n' +
          chalk.dim(
            `${INDENT}Agents arretes. Tapez un message pour relancer, ou Ctrl+C pour quitter.\n`,
          ),
      );
    }
  });

  // ── Task tags ────────────────────────────────────────────────────────────────

  const applyDones = useCallback((dones: string[]) => {
    if (dones.length === 0) return;
    setTodos((prev) => {
      let updated = [...prev];
      for (const done of dones) {
        const lower = done.toLowerCase();
        let idx = updated.findIndex((t) => !t.done && t.text.toLowerCase().includes(lower));
        if (idx === -1) {
          idx = updated.findIndex((t) => !t.done && lower.includes(t.text.toLowerCase()));
        }
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

  const processTaskTags = useCallback(
    (agent: AgentId, text: string) => {
      const { adds, dones } = extractTasks(text);
      if (adds.length === 0 && dones.length === 0) return;

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

      if (dones.length > 0) {
        if (agent === 'sonnet' || agent === 'codex') {
          const existing = pendingAgentDones.current.get(agent) ?? [];
          pendingAgentDones.current.set(agent, [...existing, ...dones]);
        } else {
          applyDones(dones);
        }
      }
    },
    [applyDones],
  );

  // ── Orchestrator binding (extracted hook) ─────────────────────────────────

  useOrchestratorBinding({
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
    setTodos,
    setTodosHiddenAt,
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
  });

  // ── Slash commands + input handler (extracted hooks) ───────────────────────

  const handleSlashCommand = useSlashCommands({
    enabledAgentSet,
    onOpenSessions: () => setShowSlashMenu(true),
  });

  const handleInput = useInputHandler({
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
  });

  const anyRunning = useMemo(
    () => Object.values(agentStatuses).some((s) => s === 'running'),
    [agentStatuses],
  );
  const anyCompacting = useMemo(
    () => Object.values(agentStatuses).some((s) => s === 'compacting'),
    [agentStatuses],
  );

  return (
    <Box flexDirection="column">
      <Text> </Text>
      {thinking ? <ThinkingSpinner compacting={anyCompacting} /> : <Text> </Text>}
      {Object.keys(agentErrors).length > 0 && (
        <Box paddingX={1} flexDirection="column">
          {Object.entries(agentErrors).map(([agent, msg]) => (
            <Text key={agent} color="red">
              {' ⚠ '}
              {msg}
            </Text>
          ))}
        </Box>
      )}
      {todosVisible && <TodoPanel items={todos} />}
      <Box paddingX={1}>
        <Text color={anyRunning ? THEME.opus : THEME.panelBorder}>
          {'─'.repeat(Math.max(10, (stdout.columns || 80) - 2))}
        </Text>
      </Box>
      {showSlashMenu ? (
        <Box paddingX={1} flexDirection="column">
          <SlashMenu
            onClose={() => setShowSlashMenu(false)}
            enabledAgents={enabledAgentSet}
            projectDir={projectDir}
            onResumeSession={(sessionId) => {
              setShowSlashMenu(false);
              (async () => {
                const sm = orchestrator.getSessionManager();
                if (!sm) return;
                const session = await sm.loadSession(sessionId);
                if (session) {
                  printSessionResume(session, sessionId);
                  const resumePrompt = buildResumePrompt(session);
                  setThinking(true);
                  orchestrator.startWithTask(resumePrompt).catch((err) => {
                    flog.error('UI', `[DASHBOARD] Resume error: ${err}`);
                  });
                } else {
                  console.log(chalk.red(`  Session non trouvee ou corrompue.`));
                }
              })().catch((err) => flog.error('UI', `[DASHBOARD] Session resume error: ${err}`));
            }}
          />
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color={anyRunning ? THEME.opus : THEME.muted}>{'\u276F '}</Text>
          <InputBar
            onSubmit={handleInput}
            projectDir={projectDir}
            placeholder={stopped ? 'Tapez pour relancer les agents...' : 'Message, @agent ou /help'}
          />
        </Box>
      )}
      <Box paddingX={1}>
        <Text color={anyRunning ? THEME.opus : THEME.panelBorder}>
          {'─'.repeat(Math.max(10, (stdout.columns || 80) - 2))}
        </Text>
      </Box>
      <Box paddingX={1} paddingTop={0} width={stdout.columns || 80}>
        <Text>
          <Text dimColor>{'esc '}</Text>
          <Text color={THEME.muted}>{'stop'}</Text>
          <Text dimColor>{' \u00B7 '}</Text>
          <Text dimColor>{'^C '}</Text>
          <Text color={THEME.muted}>{'quit'}</Text>
          <Text dimColor>{' \u00B7 '}</Text>
          <Text dimColor>{'/ '}</Text>
          <Text color={THEME.muted}>{'cmds'}</Text>
        </Text>
        <Box flexGrow={1} justifyContent="flex-end" gap={1}>
          {visibleAgents.map((id) => {
            const s = agentStatuses[id];
            const color =
              s === 'running'
                ? THEME[id]
                : s === 'compacting'
                  ? 'yellow'
                  : s === 'error'
                    ? 'red'
                    : THEME.muted;
            const icon =
              s === 'running' ? '●' : s === 'compacting' ? '◉' : s === 'error' ? '✖' : '○';
            return (
              <Text key={id} color={color}>
                {icon} {agentDisplayName(id)}
              </Text>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
