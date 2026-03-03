import type { ChildProcess } from 'node:child_process';
import { flog } from '../utils/log.js';

interface PendingRpc {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 client for app-server communication.
 * Manages request IDs, pending response tracking, and timeouts.
 */
export class RpcClient {
  private rpcId = 0;
  private pendingRpc = new Map<number, PendingRpc>();
  private logTag: string;
  private writeQueue: string[] = [];
  private writing = false;

  constructor(
    private getProcess: () => ChildProcess | null,
    logTag: string,
  ) {
    this.logTag = logTag;
  }

  /** Send an RPC request and wait for the response. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = this.getProcess();
      if (!proc?.stdin?.writable) {
        reject(new Error(`${this.logTag}: process not writable`));
        return;
      }

      const id = this.rpcId++;

      const timer = setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`${this.logTag}: RPC timeout for ${method} (#${id})`));
        }
      }, 30_000);

      this.pendingRpc.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method,
        id,
        params,
      });

      flog.debug('AGENT', `${this.logTag}: RPC request #${id} ${method}`);
      this.writeToStdin(proc, msg);
    });
  }

  /** Send a one-way RPC notification (no response expected). */
  notify(method: string, params: Record<string, unknown>): void {
    const proc = this.getProcess();
    if (!proc?.stdin?.writable) {
      flog.warn('AGENT', `${this.logTag}: Cannot notify — process not writable`);
      return;
    }

    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    flog.debug('AGENT', `${this.logTag}: RPC notify ${method}`);
    this.writeToStdin(proc, msg);
  }

  /** Handle an incoming server message. Returns true if it was a pending RPC response. */
  handleResponse(msg: Record<string, unknown>): boolean {
    const msgId =
      typeof msg.id === 'number' ? msg.id : typeof msg.id === 'string' ? Number(msg.id) : undefined;
    if (msgId === undefined || !this.pendingRpc.has(msgId) || msg.method) return false;

    const pending = this.pendingRpc.get(msgId)!;
    clearTimeout(pending.timer);
    this.pendingRpc.delete(msgId);

    if (msg.error && typeof msg.error === 'object') {
      const err = msg.error as Record<string, unknown>;
      const errMsg = typeof err.message === 'string' ? err.message : 'RPC error';
      pending.reject(new Error(errMsg));
    } else {
      pending.resolve(msg.result ?? null);
    }
    return true;
  }

  /** Reject all pending RPCs (used on process exit or stop). */
  rejectAll(reason: string): void {
    this.writeQueue = [];
    this.writing = false;
    for (const [id, { reject, timer }] of this.pendingRpc) {
      clearTimeout(timer);
      reject(new Error(reason));
      this.pendingRpc.delete(id);
    }
  }

  /** Reject all pending RPCs and clear timeouts (used on process exit). */
  rejectAllNoTimeout(reason: string): void {
    this.writeQueue = [];
    this.writing = false;
    const entries = [...this.pendingRpc.values()];
    this.pendingRpc.clear();
    for (const { reject, timer } of entries) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
  }

  get hasPending(): boolean {
    return this.pendingRpc.size > 0;
  }

  /** Write a JSON-RPC message to stdin via a serialized queue with backpressure. */
  private writeToStdin(proc: ChildProcess, msg: string): void {
    if (!proc.stdin?.writable) {
      flog.warn('AGENT', `${this.logTag}: stdin not writable — message dropped`);
      return;
    }
    this.writeQueue.push(msg + '\n');
    if (!this.writing) {
      this.drainQueue(proc);
    }
  }

  /** Drain the write queue, pausing on backpressure until stdin drains. */
  private drainQueue(proc: ChildProcess): void {
    this.writing = true;
    while (this.writeQueue.length > 0) {
      const next = this.writeQueue.shift()!;
      const ok = proc.stdin!.write(next);
      if (!ok) {
        // Buffer full — wait for drain then continue
        proc.stdin!.once('drain', () => {
          flog.debug('AGENT', `${this.logTag}: stdin drain resolved, resuming queue`);
          this.drainQueue(proc);
        });
        return;
      }
    }
    this.writing = false;
  }
}
