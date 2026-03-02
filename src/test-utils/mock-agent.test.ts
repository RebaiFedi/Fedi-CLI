import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent } from './mock-agent.js';

describe('MockAgent', () => {
  describe('clearHandlers', () => {
    it('removes all output handlers', () => {
      const agent = new MockAgent('opus');
      let callCount = 0;
      agent.onOutput(() => {
        callCount++;
      });
      agent.onOutput(() => {
        callCount++;
      });

      agent.emitText('before clear');
      assert.equal(callCount, 2, 'Both handlers should fire');

      agent.clearHandlers();
      callCount = 0;
      agent.emitText('after clear');
      assert.equal(callCount, 0, 'No handlers should fire after clearHandlers()');
    });

    it('removes all status handlers', () => {
      const agent = new MockAgent('sonnet');
      let callCount = 0;
      agent.onStatusChange(() => {
        callCount++;
      });
      agent.onStatusChange(() => {
        callCount++;
      });

      agent.setStatus('running');
      assert.equal(callCount, 2, 'Both handlers should fire');

      agent.clearHandlers();
      callCount = 0;
      agent.setStatus('waiting');
      assert.equal(callCount, 0, 'No handlers should fire after clearHandlers()');
    });

    it('allows re-registration after clear', () => {
      const agent = new MockAgent('codex');
      let firstCalls = 0;
      let secondCalls = 0;

      agent.onOutput(() => {
        firstCalls++;
      });
      agent.emitText('first');
      assert.equal(firstCalls, 1);

      agent.clearHandlers();
      agent.onOutput(() => {
        secondCalls++;
      });
      agent.emitText('second');
      assert.equal(firstCalls, 1, 'Old handler should not fire');
      assert.equal(secondCalls, 1, 'New handler should fire');
    });
  });

  describe('basic operations', () => {
    it('tracks sent messages', () => {
      const agent = new MockAgent('opus');
      agent.onStatusChange(() => {}); // prevent unhandled
      agent.send('hello');
      agent.send('world');
      assert.deepEqual(agent.getSentMessages(), ['hello', 'world']);
    });

    it('tracks urgent messages', () => {
      const agent = new MockAgent('sonnet');
      agent.sendUrgent('urgent1');
      assert.deepEqual(agent.getUrgentMessages(), ['urgent1']);
    });

    it('clearMessages resets sent and urgent', () => {
      const agent = new MockAgent('codex');
      agent.onStatusChange(() => {});
      agent.send('a');
      agent.sendUrgent('b');
      agent.clearMessages();
      assert.equal(agent.getSentMessages().length, 0);
      assert.equal(agent.getUrgentMessages().length, 0);
    });

    it('mute and interrupt tracking', () => {
      const agent = new MockAgent('opus');
      assert.equal(agent.isMuted(), false);
      assert.equal(agent.isInterrupted(), false);
      agent.mute();
      agent.interruptCurrentTask();
      assert.equal(agent.isMuted(), true);
      assert.equal(agent.isInterrupted(), true);
    });
  });
});
