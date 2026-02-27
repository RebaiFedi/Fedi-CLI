import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MessageSchema, type AgentId, type Message, type SessionData } from '../agents/types.js';
import { flog } from './log.js';

const SAVE_DEBOUNCE_MS = 2000;
export const RESUME_CONTEXT_MESSAGES = 15;
const SessionDataSchema = z.object({
  id: z.string(),
  version: z.literal(2),
  task: z.string(),
  projectDir: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  messages: z.array(MessageSchema),
  agentSessions: z.object({
    opus: z.string().optional(),
    claude: z.string().optional(),
    codex: z.string().optional(),
    gemini: z.string().optional(),
  }),
});

/** Build resume prompt with enough recent history for continuity. */
export function buildResumePrompt(session: SessionData): string {
  const agentMeta: Record<string, string> = {
    opus: 'Opus',
    claude: 'Sonnet',
    codex: 'Codex',
    gemini: 'Gemini',
    user: 'User',
  };

  const contextLines = session.messages.slice(-RESUME_CONTEXT_MESSAGES).map((m) => {
    const label = agentMeta[m.from] ?? m.from;
    const target = agentMeta[m.to] ?? m.to;
    const short = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
    return `[${label}->${target}] ${short}`;
  });

  return `SESSION REPRISE — Voici le contexte de la session precedente:\n\nTACHE ORIGINALE: ${session.task}\n\n--- HISTORIQUE ---\n${contextLines.join('\n')}\n--- FIN ---\n\nLa session reprend. Attends le prochain message du user.`;
}

export class SessionManager {
  private session: SessionData | null = null;
  private sessionsDir: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(projectDir: string) {
    this.sessionsDir = join(projectDir, 'sessions');
  }

  async createSession(task: string, projectDir: string): Promise<SessionData> {
    try {
      await fs.access(this.sessionsDir);
    } catch {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    }

    this.session = {
      id: randomUUID(),
      version: 2,
      task,
      projectDir,
      startedAt: Date.now(),
      messages: [],
      agentSessions: {},
    };

    flog.info('SESSION', `Created session ${this.session.id}`);
    this.scheduleSave();
    return this.session;
  }

  addMessage(msg: Message): void {
    if (!this.session) return;
    this.session.messages.push(msg);
    this.scheduleSave();
  }

  setAgentSession(agent: AgentId, sessionId: string): void {
    if (!this.session) return;
    this.session.agentSessions[agent] = sessionId;
    this.scheduleSave();
  }

  async finalize(): Promise<void> {
    if (!this.session) return;
    this.session.finishedAt = Date.now();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
    flog.info('SESSION', `Finalized session ${this.session.id} (${this.session.messages.length} messages)`);
  }

  getSession(): SessionData | null {
    return this.session;
  }

  async listSessions(): Promise<
    Array<{ id: string; task: string; startedAt: number; finishedAt?: number }>
  > {
    try {
      await fs.access(this.sessionsDir);
    } catch {
      return [];
    }

    const files = (await fs.readdir(this.sessionsDir)).filter(
      (f) => f.startsWith('session-') && f.endsWith('.json'),
    );
    const loaded = await Promise.all(
      files.map(async (file) => {
        try {
          const raw = await fs.readFile(join(this.sessionsDir, file), 'utf-8');
          const parsed = SessionDataSchema.safeParse(JSON.parse(raw));
          if (!parsed.success) return null;
          const data = parsed.data;
          const meta: { id: string; task: string; startedAt: number; finishedAt?: number } = {
            id: data.id,
            task: data.task,
            startedAt: data.startedAt,
          };
          if (data.finishedAt !== undefined) {
            meta.finishedAt = data.finishedAt;
          }
          return meta;
        } catch (err) {
          flog.debug('SESSION', `Invalid session file skipped (${file}): ${String(err).slice(0, 120)}`);
          return null;
        }
      }),
    );
    const sessions: Array<{ id: string; task: string; startedAt: number; finishedAt?: number }> = [];
    for (const item of loaded) {
      if (item) sessions.push(item);
    }

    return sessions.sort((a, b) => b.startedAt - a.startedAt);
  }

  async loadSession(id: string): Promise<SessionData | null> {
    const filePath = join(this.sessionsDir, `session-${id}.json`);
    try {
      await fs.access(filePath);
    } catch {
      return null;
    }

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = SessionDataSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        flog.warn('SESSION', `Invalid session schema: ${id}`);
        return null;
      }
      return parsed.data;
    } catch (err) {
      flog.debug('SESSION', `Failed to load session ${id}: ${String(err).slice(0, 120)}`);
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk().catch((err) => flog.error('SESSION', `Scheduled save failed: ${err}`));
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveToDisk(): Promise<void> {
    if (!this.session) return;

    try {
      await fs.access(this.sessionsDir);
    } catch {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    }

    const filePath = join(this.sessionsDir, `session-${this.session.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    try {
      // Atomic write: write to temp file, then rename (rename is atomic on POSIX)
      await fs.writeFile(tmpPath, JSON.stringify(this.session, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
      flog.debug('SESSION', `Saved to ${filePath}`);
    } catch (err) {
      flog.error('SESSION', `Failed to save: ${err}`);
      // Clean up temp file on failure
      try {
        await fs.unlink(tmpPath);
      } catch (unlinkErr) {
        flog.debug('SESSION', `Temp cleanup skipped: ${String(unlinkErr).slice(0, 120)}`);
      }
    }
  }
}
