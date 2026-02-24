import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../agents/types.js';
import { MAX_RELAY_DEPTH } from '../agents/types.js';
import { MessageBus } from './message-bus.js';

test('send emits global and targeted events', () => {
  const bus = new MessageBus();
  const allMessages: Message[] = [];
  const claudeMessages: Message[] = [];
  const codexMessages: Message[] = [];

  bus.on('message', (msg) => allMessages.push(msg));
  bus.on('message:claude', (msg) => claudeMessages.push(msg));
  bus.on('message:codex', (msg) => codexMessages.push(msg));

  const sent = bus.send({
    from: 'user',
    to: 'claude',
    content: 'Need API contract',
  });

  assert.equal(allMessages.length, 1);
  assert.equal(claudeMessages.length, 1);
  assert.equal(codexMessages.length, 0);
  assert.equal(allMessages[0].id, sent.id);
  assert.equal(bus.getHistory().length, 1);
});

test('relay emits relay event and increments relay count', () => {
  const bus = new MessageBus();
  const relayEvents: Message[] = [];

  bus.on('relay', (msg) => relayEvents.push(msg));

  const ok = bus.relay('codex', 'claude', 'Endpoint ready');

  assert.equal(ok, true);
  assert.equal(relayEvents.length, 1);
  assert.equal(relayEvents[0].from, 'codex');
  assert.equal(relayEvents[0].to, 'claude');
  assert.equal(relayEvents[0].relayCount, 1);
  assert.ok(relayEvents[0].correlationId);
  assert.equal(bus.getRelayHistory().length, 1);
});

test('relay blocks once correlation chain reaches MAX_RELAY_DEPTH', () => {
  const bus = new MessageBus();
  const blocked: Message[] = [];
  const correlationId = 'corr-123';

  bus.on('relay-blocked', (msg) => blocked.push(msg));

  for (let i = 0; i < MAX_RELAY_DEPTH; i += 1) {
    const ok = bus.relay('claude', 'codex', `hop-${i + 1}`, correlationId);
    assert.equal(ok, true);
  }

  const finalAttempt = bus.relay('claude', 'codex', 'hop-blocked', correlationId);

  assert.equal(finalAttempt, false);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].relayCount, MAX_RELAY_DEPTH);
  assert.equal(blocked[0].correlationId, correlationId);
  assert.equal(bus.getRelayHistory().length, MAX_RELAY_DEPTH);
});
