import { describe, it } from 'node:test';
import assert from 'node:assert';
import { VERSION } from './version.js';

describe('VERSION', () => {
  it('exports a non-empty string', () => {
    assert.strictEqual(typeof VERSION, 'string');
    assert.ok(VERSION.length > 0, 'VERSION should not be empty');
  });

  it('follows semver-like format', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/, 'VERSION should be semver-like');
  });
});
