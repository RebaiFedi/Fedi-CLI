import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentMessageDelta, type ItemHandlerDeps } from './item-handlers.js';
import type { OutputLine } from './types.js';

function makeDeps() {
  let buffer = '';
  let hadDeltas = false;
  let streamedLength = 0;
  const emitted: OutputLine[] = [];

  const deps: ItemHandlerDeps = {
    logTag: 'TEST',
    emit: (line) => emitted.push(line),
    emitCheckpoint: () => {},
    consumeEchoSuppression: () => false,
    getMessageBuffer: () => ({ buffer, hadDeltas }),
    resetMessageBuffer: () => {
      buffer = '';
      hadDeltas = false;
      streamedLength = 0;
    },
    appendToMessageBuffer: (delta) => {
      buffer += delta;
      hadDeltas = true;
    },
    getStreamedLength: () => streamedLength,
    setStreamedLength: (n) => {
      streamedLength = n;
    },
    getPendingFileChangeDiff: () => null,
    setPendingFileChangeDiff: () => {},
    getPendingFileChangePath: () => null,
    setPendingFileChangePath: () => {},
  };

  return { deps, emitted, getStreamedLength: () => streamedLength };
}

describe('handleAgentMessageDelta', () => {
  it('streams completed paragraph and emits explicit separator', () => {
    const { deps, emitted, getStreamedLength } = makeDeps();

    handleAgentMessageDelta(deps, { delta: 'Paragraphe 1\n\nParagraphe 2' });

    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]?.text, 'Paragraphe 1');
    assert.equal(emitted[1]?.text, '\n');
    assert.equal(getStreamedLength(), 'Paragraphe 1\n\n'.length);
  });

  it('soft-streams long text without paragraph break', () => {
    const { deps, emitted, getStreamedLength } = makeDeps();
    const longText =
      'Le football est un sport collectif tres populaire dans le monde entier, ' +
      'pratique dans les ecoles, les quartiers et les stades, avec des qualites ' +
      "comme la technique, la vitesse et l'intelligence tactique qui font la difference.";

    handleAgentMessageDelta(deps, { delta: longText });

    // With threshold=80, long text gets split into multiple soft chunks
    assert.ok(emitted.length >= 1, `Should emit at least 1 chunk, got ${emitted.length}`);
    assert.ok(emitted[0]!.text.length > 30, 'First chunk should have meaningful length');
    assert.ok(getStreamedLength() > 0);
    assert.ok(getStreamedLength() < longText.length);
  });

  it('does not emit for short partial text', () => {
    const { deps, emitted, getStreamedLength } = makeDeps();

    handleAgentMessageDelta(deps, { delta: 'Court extrait en cours' });

    assert.equal(emitted.length, 0);
    assert.equal(getStreamedLength(), 0);
  });
});
