import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AgentId, Message, SessionData } from '../agents/types.js';
import { logger } from './logger.js';

const SAVE_DEBOUNCE_MS = 2000;

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

    logger.info(`[SESSION] Created session ${this.session.id}`);
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
    logger.info(
      `[SESSION] Finalized session ${this.session.id} (${this.session.messages.length} messages)`,
    );
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
    const sessions: Array<{ id: string; task: string; startedAt: number; finishedAt?: number }> =
      [];

    for (const file of files) {
      try {
        const raw = await fs.readFile(join(this.sessionsDir, file), 'utf-8');
        const data = JSON.parse(raw);
        if (data.version === 2) {
          sessions.push({
            id: data.id,
            task: data.task,
            startedAt: data.startedAt,
            finishedAt: data.finishedAt,
          });
        }
      } catch {
        // Skip corrupt files
      }
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
      const data = JSON.parse(raw);
      if (data.version !== 2) return null;
      return data as SessionData;
    } catch {
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk().catch((err) => logger.error(`[SESSION] Scheduled save failed: ${err}`));
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
    try {
      await fs.writeFile(filePath, JSON.stringify(this.session, null, 2), 'utf-8');
      logger.debug(`[SESSION] Saved to ${filePath}`);
    } catch (err) {
      logger.error(`[SESSION] Failed to save: ${err}`);
    }
  }
}
