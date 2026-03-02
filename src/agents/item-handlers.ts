import type { OutputLine, ToolMeta } from './types.js';
import { flog } from '../utils/log.js';
import { formatAction } from '../utils/format-action.js';

/**
 * Callbacks required by item handlers to interact with the agent.
 */
export interface ItemHandlerDeps {
  readonly logTag: string;
  emit(line: OutputLine): void;
  emitCheckpoint(text: string): void;
  /** Returns and decrements suppressUserEchoCount if > 0. */
  consumeEchoSuppression(): boolean;
  /** Get current agent message buffer and whether deltas were received. */
  getMessageBuffer(): { buffer: string; hadDeltas: boolean };
  /** Reset the agent message buffer. */
  resetMessageBuffer(): void;
  /** Append to agent message buffer. */
  appendToMessageBuffer(delta: string): void;
  /** Get/set pending file change diff. */
  getPendingFileChangeDiff(): string | null;
  setPendingFileChangeDiff(diff: string | null): void;
  getPendingFileChangePath(): string | null;
  setPendingFileChangePath(path: string | null): void;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Try to extract text from various item shapes. */
export function extractText(item: Record<string, unknown>): string | undefined {
  if (Array.isArray(item.content)) {
    const texts: string[] = [];
    for (const block of item.content as Array<Record<string, unknown>>) {
      if (typeof block.text === 'string') texts.push(block.text);
    }
    if (texts.length > 0) return texts.join('\n');
  }
  if (Array.isArray(item.output)) {
    const texts: string[] = [];
    for (const block of item.output as Array<Record<string, unknown>>) {
      if (typeof block.text === 'string') texts.push(block.text);
    }
    if (texts.length > 0) return texts.join('\n');
  }
  if (typeof item.text === 'string' && item.text.trim()) return item.text;
  if (typeof item.output === 'string' && item.output.trim()) return item.output;
  return undefined;
}

/**
 * Detect file creation commands (cat > file <<'EOF'..., tee file <<'EOF'...).
 * Returns { file, lines } if detected, null otherwise.
 */
export function detectFileCreateCommand(command: string): { file: string; lines: string[] } | null {
  let cmd = command.trim();
  cmd = cmd.replace(/^\/bin\/(?:ba)?sh\s+-lc\s+/, '');
  if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
    cmd = cmd.slice(1, -1);
  }
  cmd = cmd.replace(/^cd\s+['"][^'"]*['"]\s*&&\s*/, '');
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, '');
  cmd = cmd.trim();

  // Pattern 1: cat > file <<'EOF'
  const catMatch = cmd.match(/^cat\s+>\s*(\S+)\s*<<\s*'?(\w+)'?\s*\n([\s\S]*)/);
  if (catMatch) {
    const file = catMatch[1];
    const delimiter = catMatch[2];
    const rest = catMatch[3];
    const delimRe = new RegExp(`^${delimiter}\\s*$`, 'm');
    const delimIdx = rest.search(delimRe);
    const content = delimIdx >= 0 ? rest.slice(0, delimIdx) : rest;
    return { file, lines: content.split('\n') };
  }

  // Pattern 2: tee file <<'EOF'
  const teeMatch = cmd.match(/^tee\s+(?:-a\s+)?(\S+)\s*<<\s*'?(\w+)'?\s*\n([\s\S]*)/);
  if (teeMatch) {
    const file = teeMatch[1];
    const delimiter = teeMatch[2];
    const rest = teeMatch[3];
    const delimRe = new RegExp(`^${delimiter}\\s*$`, 'm');
    const delimIdx = rest.search(delimRe);
    const content = delimIdx >= 0 ? rest.slice(0, delimIdx) : rest;
    return { file, lines: content.split('\n') };
  }

  return null;
}

// ── Event handlers ────────────────────────────────────────────────────────

export function handleItemStarted(deps: ItemHandlerDeps, params: Record<string, unknown>): void {
  const item =
    params.item && typeof params.item === 'object'
      ? (params.item as Record<string, unknown>)
      : params;
  const itemType = typeof item.type === 'string' ? item.type : undefined;

  if (itemType === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : undefined;
    if (command) {
      const fileCreateInfo = detectFileCreateCommand(command);
      if (fileCreateInfo) {
        deps.emitCheckpoint(`[CODEX:checkpoint] File create: ${fileCreateInfo.file}`);
      } else {
        deps.emitCheckpoint(`[CODEX:checkpoint] Running: ${command.slice(0, 100)}`);
      }
    }
  } else if (itemType === 'fileChange' || itemType === 'file_change') {
    deps.setPendingFileChangeDiff(null);
    deps.setPendingFileChangePath(null);
  } else if (itemType === 'fileRead' || itemType === 'file_read' || itemType === 'read_file') {
    const filename =
      typeof item.filename === 'string'
        ? item.filename
        : typeof item.path === 'string'
          ? item.path
          : undefined;
    if (filename) {
      deps.emitCheckpoint(`[CODEX:checkpoint] Reading: ${filename}`);
    }
  }

  if (
    itemType === 'agent_message' ||
    itemType === 'agentMessage' ||
    itemType === 'message' ||
    itemType === 'output_message'
  ) {
    deps.resetMessageBuffer();
  }
}

export function handleItemCompleted(deps: ItemHandlerDeps, params: Record<string, unknown>): void {
  const item =
    params.item && typeof params.item === 'object'
      ? (params.item as Record<string, unknown>)
      : params;
  const itemType = typeof item.type === 'string' ? item.type : undefined;
  const itemStatus = typeof item.status === 'string' ? item.status : undefined;

  // Reasoning — log only
  if (itemType === 'reasoning') {
    if (typeof item.text === 'string')
      flog.debug('AGENT', `${deps.logTag} reasoning: ${item.text.slice(0, 120)}`);
    return;
  }

  // User message echo — suppress
  const role = typeof item.role === 'string' ? item.role : undefined;
  if (role === 'user') {
    flog.debug('AGENT', `${deps.logTag}: Suppressed user message echo`);
    return;
  }

  // Agent message — final text
  if (itemType === 'agent_message' || itemType === 'agentMessage') {
    if (deps.consumeEchoSuppression()) {
      deps.resetMessageBuffer();
      flog.debug('AGENT', `${deps.logTag}: Suppressed user-message echo (fused system prompt)`);
      return;
    }
    const { buffer, hadDeltas } = deps.getMessageBuffer();
    const text = hadDeltas ? buffer.trim() : extractText(item);
    deps.resetMessageBuffer();
    if (text) {
      deps.emit({ text, timestamp: Date.now(), type: 'stdout' });
    }
    return;
  }

  // OpenAI Responses API message types
  if (itemType === 'message' || itemType === 'output_message') {
    if (deps.consumeEchoSuppression()) {
      deps.resetMessageBuffer();
      flog.debug('AGENT', `${deps.logTag}: Suppressed user-message echo (fused system prompt)`);
      return;
    }
    const { buffer, hadDeltas } = deps.getMessageBuffer();
    const text = hadDeltas ? buffer.trim() : extractText(item);
    deps.resetMessageBuffer();
    if (text) {
      deps.emit({ text, timestamp: Date.now(), type: 'stdout' });
    }
    return;
  }

  // Command execution completed
  if (itemType === 'commandExecution' || itemType === 'command_execution') {
    handleCommandCompleted(deps, item, itemStatus);
    return;
  }

  // File change completed
  if (itemType === 'fileChange' || itemType === 'file_change') {
    handleFileChangeCompleted(deps, item, itemStatus);
    return;
  }

  // File read completed
  if (itemType === 'fileRead' || itemType === 'file_read' || itemType === 'read_file') {
    const filename =
      typeof item.filename === 'string'
        ? item.filename
        : typeof item.path === 'string'
          ? item.path
          : undefined;
    if (filename) {
      const formatted = formatAction('read', filename);
      if (formatted) {
        const meta: ToolMeta = { tool: 'read', file: filename };
        deps.emit({ text: formatted, timestamp: Date.now(), type: 'system', toolMeta: meta });
      }
      deps.emitCheckpoint(`[CODEX:checkpoint] Read: ${filename}`);
    }
    return;
  }

  // Generic content array
  if (Array.isArray(item.content)) {
    if (deps.consumeEchoSuppression()) {
      flog.debug(
        'AGENT',
        `${deps.logTag}: Suppressed user-message echo (content array, fused system prompt)`,
      );
      return;
    }
    for (const block of item.content as Array<Record<string, unknown>>) {
      if (typeof block.text === 'string') {
        deps.emit({ text: block.text, timestamp: Date.now(), type: 'stdout' });
      }
    }
    return;
  }

  // Catch-all text extraction
  if (deps.consumeEchoSuppression()) {
    flog.debug(
      'AGENT',
      `${deps.logTag}: Suppressed user-message echo (catch-all, fused system prompt)`,
    );
    return;
  }
  const fallbackText = extractText(item);
  if (fallbackText) {
    deps.emit({ text: fallbackText, timestamp: Date.now(), type: 'stdout' });
  } else {
    flog.debug(
      'AGENT',
      `${deps.logTag}: item/completed type="${itemType}" — no text extracted. Keys: ${Object.keys(item).join(', ')}`,
    );
  }
}

// ── Sub-handlers for handleItemCompleted ──────────────────────────────────

function handleCommandCompleted(
  deps: ItemHandlerDeps,
  item: Record<string, unknown>,
  _itemStatus: string | undefined,
): void {
  const command = typeof item.command === 'string' ? item.command : undefined;
  const exitCode =
    typeof item.exitCode === 'number'
      ? item.exitCode
      : typeof item.exit_code === 'number'
        ? item.exit_code
        : undefined;
  if (!command) return;

  const fileCreateInfo = detectFileCreateCommand(command);
  if (fileCreateInfo && (exitCode === undefined || exitCode === 0)) {
    const createFormatted = formatAction('create', fileCreateInfo.file);
    if (createFormatted) {
      const meta: ToolMeta = { tool: 'create', file: fileCreateInfo.file };
      if (fileCreateInfo.lines.length > 0) meta.newLines = fileCreateInfo.lines;
      flog.debug(
        'AGENT',
        `${deps.logTag}: Detected file create via bash: ${fileCreateInfo.file} (${fileCreateInfo.lines.length} lines)`,
      );
      deps.emit({
        text: createFormatted,
        timestamp: Date.now(),
        type: 'system',
        toolMeta: meta,
      });
    }
  } else {
    const formatted = formatAction('bash', command);
    if (formatted) {
      const suffix = exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode})` : '';
      const meta: ToolMeta = { tool: 'bash', command, exitCode };
      deps.emit({
        text: `${formatted}${suffix}`,
        timestamp: Date.now(),
        type: 'system',
        toolMeta: meta,
      });
    }
  }

  if (exitCode !== undefined && exitCode !== 0) {
    const stderr = typeof item.stderr === 'string' ? item.stderr : undefined;
    if (stderr) {
      const short = stderr.length > 200 ? stderr.slice(0, 200) + '...' : stderr;
      deps.emit({ text: short, timestamp: Date.now(), type: 'info' });
    }
  }

  deps.emitCheckpoint(
    `[CODEX:checkpoint] Command: ${command.slice(0, 100)}${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`,
  );
}

function handleFileChangeCompleted(
  deps: ItemHandlerDeps,
  item: Record<string, unknown>,
  itemStatus: string | undefined,
): void {
  flog.debug(
    'AGENT',
    `${deps.logTag}: fileChange raw keys=${Object.keys(item).join(',')} changes=${Array.isArray(item.changes)} hasFilename=${!!item.filename} hasPath=${!!item.path} hasDiff=${!!item.diff}`,
  );

  const changes: Array<Record<string, unknown>> = Array.isArray(item.changes)
    ? (item.changes as Array<Record<string, unknown>>)
    : item.filename || item.path || item.diff
      ? [item as Record<string, unknown>]
      : [];

  if (changes.length === 0) return;

  for (const change of changes) {
    const file =
      typeof change.path === 'string'
        ? change.path
        : typeof change.filename === 'string'
          ? change.filename
          : undefined;
    const kind = typeof change.kind === 'string' ? change.kind : undefined;

    flog.debug(
      'AGENT',
      `${deps.logTag}: fileChange detail: kind=${kind} file=${file} keys=${Object.keys(change).join(',')}`,
    );

    if (!file) continue;

    const diff =
      typeof change.diff === 'string'
        ? change.diff
        : (deps.getPendingFileChangeDiff() ?? undefined);

    flog.debug(
      'AGENT',
      `${deps.logTag}: fileChange diff source: change.diff=${typeof change.diff === 'string'} pending=${!!deps.getPendingFileChangeDiff()} hasDiff=${!!diff} diffLen=${diff?.length ?? 0}`,
    );

    // Parse diff lines
    const oldLines: string[] = [];
    const newLines: string[] = [];
    if (diff) {
      for (const dl of diff.split('\n')) {
        if (dl.startsWith('-') && !dl.startsWith('---')) oldLines.push(dl.slice(1));
        else if (dl.startsWith('+') && !dl.startsWith('+++')) newLines.push(dl.slice(1));
      }
    }

    // Detect create vs edit
    let label: 'create' | 'edit' | 'delete';
    if (kind === 'add' || kind === 'create') {
      label = 'create';
    } else if (kind === 'delete' || kind === 'remove') {
      label = 'delete';
    } else if (diff && oldLines.length === 0) {
      label = 'create';
    } else {
      label = 'edit';
    }

    const meta: ToolMeta = { tool: label, file };

    if (oldLines.length > 0) meta.oldLines = oldLines;
    if (newLines.length > 0) {
      meta.newLines = newLines;
    } else if (diff && diff.trim().length > 0 && oldLines.length === 0 && newLines.length === 0) {
      meta.newLines = diff.split('\n');
      label = 'create';
      meta.tool = 'create';
      flog.debug('AGENT', `${deps.logTag}: fileChange diff is raw content, treating as create`);
    }

    // Fallback: content/new_content fields for create
    if (!meta.newLines?.length && label === 'create') {
      const content =
        typeof change.content === 'string'
          ? change.content
          : typeof change.new_content === 'string'
            ? change.new_content
            : undefined;
      if (content) meta.newLines = content.split('\n');
    }

    flog.debug(
      'AGENT',
      `${deps.logTag}: fileChange result: label=${label} old=${meta.oldLines?.length ?? 0} new=${meta.newLines?.length ?? 0}`,
    );

    const formatted = formatAction(label, file);
    if (formatted) {
      const suffix = itemStatus && itemStatus !== 'completed' ? ` (${itemStatus})` : '';
      deps.emit({
        text: `${formatted}${suffix}`,
        timestamp: Date.now(),
        type: 'system',
        toolMeta: meta,
      });
    }

    deps.setPendingFileChangeDiff(null);
    deps.setPendingFileChangePath(null);
  }
}

// ── Delta handlers ────────────────────────────────────────────────────────

export function handleAgentMessageDelta(
  deps: ItemHandlerDeps,
  params: Record<string, unknown>,
): void {
  const delta = typeof params.delta === 'string' ? params.delta : undefined;
  if (delta) {
    deps.appendToMessageBuffer(delta);
  }
}

export function handleCommandOutputDelta(logTag: string, params: Record<string, unknown>): void {
  const delta = typeof params.delta === 'string' ? params.delta : undefined;
  if (delta) {
    flog.debug('AGENT', `${logTag}: command output: ${delta.slice(0, 120)}`);
  }
}

export function handleFileChangeOutputDelta(
  deps: ItemHandlerDeps,
  params: Record<string, unknown>,
): void {
  const delta = typeof params.delta === 'string' ? params.delta : undefined;
  if (delta) {
    const current = deps.getPendingFileChangeDiff() ?? '';
    deps.setPendingFileChangeDiff(current + delta);
    flog.debug(
      'AGENT',
      `${deps.logTag}: fileChange outputDelta: +${delta.length} chars (total: ${(current + delta).length})`,
    );
  }
  const item =
    params.item && typeof params.item === 'object'
      ? (params.item as Record<string, unknown>)
      : undefined;
  if (item) {
    const file =
      typeof item.filename === 'string'
        ? item.filename
        : typeof item.path === 'string'
          ? item.path
          : undefined;
    if (file) deps.setPendingFileChangePath(file);
  }
}

export function handleTurnDiffUpdated(
  logTag: string,
  deps: ItemHandlerDeps,
  params: Record<string, unknown>,
): void {
  flog.debug('AGENT', `${logTag}: turn/diff/updated keys=${Object.keys(params).join(',')}`);
  const diff = typeof params.diff === 'string' ? params.diff : undefined;
  if (diff) {
    deps.setPendingFileChangeDiff(diff);
    flog.debug('AGENT', `${logTag}: turn/diff: ${diff.length} chars`);
  }
  if (Array.isArray(params.files)) {
    for (const f of params.files as Array<Record<string, unknown>>) {
      flog.debug('AGENT', `${logTag}: turn/diff file: ${JSON.stringify(f).slice(0, 200)}`);
    }
  }
}

export function handleError(
  logTag: string,
  emit: (line: OutputLine) => void,
  setStatus: (s: 'error') => void,
  setLastError: (e: string) => void,
  params: Record<string, unknown>,
): void {
  let errorMsg = 'Unknown error';
  if (params.error && typeof params.error === 'object') {
    const err = params.error as Record<string, unknown>;
    if (typeof err.message === 'string') errorMsg = err.message;
  } else if (typeof params.message === 'string') {
    errorMsg = params.message;
  } else if (typeof params.error === 'string') {
    errorMsg = params.error;
  }
  const willRetry = typeof params.willRetry === 'boolean' ? params.willRetry : false;

  // Transient reconnection warnings — ignore
  if (
    /reconnect/i.test(errorMsg) ||
    /stream disconnect/i.test(errorMsg) ||
    /connection closed/i.test(errorMsg)
  ) {
    flog.warn('AGENT', `${logTag}: Transient warning (non-fatal): ${errorMsg}`);
    return;
  }

  if (willRetry) {
    flog.warn('AGENT', `${logTag}: Error (will retry): ${errorMsg}`);
    emit({
      text: `Codex: ${errorMsg} (retry en cours...)`,
      timestamp: Date.now(),
      type: 'info',
    });
    return;
  }

  flog.error('AGENT', `${logTag}: Error: ${errorMsg}`);
  setLastError(errorMsg);
  emit({ text: `Codex error: ${errorMsg}`, timestamp: Date.now(), type: 'info' });
  setStatus('error');
}
