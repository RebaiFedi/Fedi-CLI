import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { RpcClient } from './rpc-client.js';

/**
 * Minimal mock stdin that tracks writes and simulates backpressure.
 */
class MockStdin extends EventEmitter {
  writable = true;
  written: string[] = [];
  private backpressure = false;

  write(data: string): boolean {
    this.written.push(data);
    return !this.backpressure;
  }

  /** Enable backpressure — write() returns false. */
  setBackpressure(on: boolean): void {
    this.backpressure = on;
  }

  /** Simulate a drain event (buffer ready for more writes). */
  simulateDrain(): void {
    this.emit('drain');
  }
}

function createMockProcess(): { proc: ChildProcess; stdin: MockStdin } {
  const stdin = new MockStdin();
  const proc = { stdin } as unknown as ChildProcess;
  return { proc, stdin };
}

describe('RpcClient write queue', () => {
  let client: RpcClient;
  let stdin: MockStdin;

  beforeEach(() => {
    const { proc, stdin: s } = createMockProcess();
    stdin = s;
    client = new RpcClient(() => proc, 'test-agent');
  });

  it('writes messages to stdin normally when no backpressure', () => {
    client.notify('test/method', { foo: 'bar' });
    assert.equal(stdin.written.length, 1);
    const parsed = JSON.parse(stdin.written[0].trim());
    assert.equal(parsed.method, 'test/method');
    assert.deepEqual(parsed.params, { foo: 'bar' });
  });

  it('queues messages on backpressure and resumes after drain', () => {
    // First message goes through, but returns false (backpressure)
    stdin.setBackpressure(true);

    client.notify('msg/1', {});
    client.notify('msg/2', {});
    client.notify('msg/3', {});

    // First message written immediately (despite backpressure return),
    // but queue pauses after that
    assert.equal(stdin.written.length, 1);
    assert.ok(stdin.written[0].includes('msg/1'));

    // Simulate drain — queue should resume
    stdin.setBackpressure(false);
    stdin.simulateDrain();

    assert.equal(stdin.written.length, 3);
    assert.ok(stdin.written[1].includes('msg/2'));
    assert.ok(stdin.written[2].includes('msg/3'));
  });

  it('drops message when stdin is not writable', () => {
    const { proc, stdin: deadStdin } = createMockProcess();
    deadStdin.writable = false;
    const rpc = new RpcClient(() => proc, 'dead-agent');

    // Should not throw, just drop
    rpc.notify('dropped/method', {});
    assert.equal(deadStdin.written.length, 0);
  });

  it('rejectAll clears the write queue', () => {
    stdin.setBackpressure(true);

    client.notify('msg/1', {});
    client.notify('msg/2', {});
    // msg/1 was written, msg/2 is queued

    client.rejectAll('test shutdown');

    // Drain should NOT cause more writes after rejectAll
    stdin.setBackpressure(false);
    stdin.simulateDrain();

    assert.equal(stdin.written.length, 1, 'only the first message should have been written');
  });

  it('rejectAllNoTimeout clears the write queue', () => {
    stdin.setBackpressure(true);

    client.notify('msg/1', {});
    client.notify('msg/2', {});

    client.rejectAllNoTimeout('test exit');

    stdin.setBackpressure(false);
    stdin.simulateDrain();

    assert.equal(stdin.written.length, 1, 'only the first message should have been written');
  });

  it('handles multiple drain cycles correctly', () => {
    // Send 5 messages with backpressure after each one
    stdin.setBackpressure(true);

    for (let i = 0; i < 5; i++) {
      client.notify(`msg/${i}`, {});
    }

    assert.equal(stdin.written.length, 1);

    // Drain once but keep backpressure — should write one more then pause
    stdin.simulateDrain();
    assert.equal(stdin.written.length, 2);

    // Drain again — one more
    stdin.simulateDrain();
    assert.equal(stdin.written.length, 3);

    // Remove backpressure and drain — remaining should all flush
    stdin.setBackpressure(false);
    stdin.simulateDrain();
    assert.equal(stdin.written.length, 5);
  });
});
