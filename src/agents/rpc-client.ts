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
      const ok = proc.stdin.write(msg + '\n');
      if (!ok) {
        proc.stdin.once('drain', () => {});
      }
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
    const ok = proc.stdin.write(msg + '\n');
    if (!ok) {
      proc.stdin.once('drain', () => {});
    }
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
    for (const [id, { reject, timer }] of this.pendingRpc) {
      clearTimeout(timer);
      reject(new Error(reason));
      this.pendingRpc.delete(id);
    }
  }

  /** Reject all pending RPCs without clearing timeouts (used on process exit). */
  rejectAllNoTimeout(reason: string): void {
    for (const [id, { reject }] of this.pendingRpc) {
      reject(new Error(reason));
      this.pendingRpc.delete(id);
    }
  }

  get hasPending(): boolean {
    return this.pendingRpc.size > 0;
  }
}
