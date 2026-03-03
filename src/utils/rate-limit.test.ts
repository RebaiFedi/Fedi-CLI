import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimitWindow, isRateLimitActive } from './rate-limit.js';

describe('parseRateLimitWindow', () => {
  it('parses reset time with timezone', () => {
    const now = Date.UTC(2026, 2, 3, 8, 0, 0); // 09:00 in Africa/Tunis
    const parsed = parseRateLimitWindow(
      "You've hit your limit · resets 12pm (Africa/Tunis)",
      now,
      'UTC',
    );
    assert.ok(parsed);
    assert.equal(parsed!.timezone, 'Africa/Tunis');
    assert.ok(parsed!.resetAtMs > now);
    assert.ok(parsed!.resetLabel.includes('Africa/Tunis'));
  });

  it('rolls to next day if reset time already passed locally', () => {
    const now = Date.UTC(2026, 2, 3, 14, 0, 0); // 15:00 in Africa/Tunis
    const parsed = parseRateLimitWindow(
      "You've hit your limit · resets 12pm (Africa/Tunis)",
      now,
      'UTC',
    );
    assert.ok(parsed);
    const delta = parsed!.resetAtMs - now;
    assert.ok(delta > 20 * 60 * 60 * 1000, 'should be roughly next day');
    assert.ok(delta < 26 * 60 * 60 * 1000, 'should not exceed ~1 day');
  });

  it('returns null when no reset time is present', () => {
    const parsed = parseRateLimitWindow('rate limit reached');
    assert.equal(parsed, null);
  });
});

describe('isRateLimitActive', () => {
  it('is true before reset and false after reset', () => {
    const window = {
      resetAtMs: 1_000,
      timezone: 'UTC',
      resetLabel: '12pm (UTC)',
    };
    assert.equal(isRateLimitActive(window, 999), true);
    assert.equal(isRateLimitActive(window, 1_000), false);
  });
});

