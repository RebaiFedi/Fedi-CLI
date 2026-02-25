import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

  createSession(task: string, projectDir: string): SessionData {
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }

    this.session = {
      id: randomUUID(),
      version: 2,
      task,
      projectDir,
      startedAt: Date.now(),
      messages: [],
      agentSessions: {},
      agentStats: {},
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

  finalize(): void {
    if (!this.session) return;
    this.session.finishedAt = Date.now();
    // Flush immediately on finalize
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
    logger.info(`[SESSION] Finalized session ${this.session.id} (${this.session.messages.length} messages)`);
  }

  getSession(): SessionData | null {
    return this.session;
  }

  listSessions(): Array<{ id: string; task: string; startedAt: number; finishedAt?: number }> {
    if (!existsSync(this.sessionsDir)) return [];

    const files = readdirSync(this.sessionsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
    const sessions: Array<{ id: string; task: string; startedAt: number; finishedAt?: number }> = [];

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(this.sessionsDir, file), 'utf-8'));
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

  loadSession(id: string): SessionData | null {
    const filePath = join(this.sessionsDir, `session-${id}.json`);
    if (!existsSync(filePath)) return null;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
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
      this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveToDisk(): void {
    if (!this.session) return;

    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }

    const filePath = join(this.sessionsDir, `session-${this.session.id}.json`);
    try {
      writeFileSync(filePath, JSON.stringify(this.session, null, 2), 'utf-8');
      logger.debug(`[SESSION] Saved to ${filePath}`);
    } catch (err) {
      logger.error(`[SESSION] Failed to save: ${err}`);
    }
  }
}
