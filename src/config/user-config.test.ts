import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadUserConfig, resetConfigCache, PROFILES, type EffortLevel } from './user-config.js';

describe('user-config', () => {
  beforeEach(() => {
    resetConfigCache();
  });
  afterEach(() => {
    resetConfigCache();
  });

  describe('loadUserConfig', () => {
    it('returns a valid config object with all required fields', () => {
      const cfg = loadUserConfig();
      // Check all fields exist and have correct types
      assert.equal(typeof cfg.execTimeoutMs, 'number');
      assert.equal(typeof cfg.codexTimeoutMs, 'number');
      assert.equal(typeof cfg.delegateTimeoutMs, 'number');
      assert.equal(typeof cfg.maxRelaysPerWindow, 'number');
      assert.equal(typeof cfg.relayWindowMs, 'number');
      assert.equal(typeof cfg.flushIntervalMs, 'number');
      assert.equal(typeof cfg.maxMessages, 'number');
      assert.equal(typeof cfg.maxCrossTalkPerRound, 'number');
      assert.equal(typeof cfg.crossTalkMuteTimeoutMs, 'number');
      assert.equal(typeof cfg.maxLogFiles, 'number');
      assert.equal(typeof cfg.claudeModel, 'string');
      assert.equal(typeof cfg.opusModel, 'string');
      assert.equal(typeof cfg.codexModel, 'string');
      assert.equal(typeof cfg.circuitBreakerThreshold, 'number');
      assert.equal(typeof cfg.sandboxMode, 'boolean');
      assert.equal(typeof cfg.opusThinking, 'boolean');
      assert.equal(typeof cfg.relayDraftFlushMs, 'number');
      assert.equal(typeof cfg.safetyNetDebounceMs, 'number');
    });

    it('effort levels are valid values', () => {
      const cfg = loadUserConfig();
      const valid: EffortLevel[] = ['high', 'medium', 'low'];
      assert.ok(valid.includes(cfg.opusEffort), `opusEffort="${cfg.opusEffort}" should be valid`);
      assert.ok(
        valid.includes(cfg.sonnetEffort),
        `sonnetEffort="${cfg.sonnetEffort}" should be valid`,
      );
      assert.ok(
        valid.includes(cfg.codexEffort),
        `codexEffort="${cfg.codexEffort}" should be valid`,
      );
    });

    it('caches config on subsequent calls', () => {
      const cfg1 = loadUserConfig();
      const cfg2 = loadUserConfig();
      assert.equal(cfg1, cfg2, 'Should return same object (cached)');
    });

    it('resetConfigCache forces fresh load', () => {
      const cfg1 = loadUserConfig();
      resetConfigCache();
      const cfg2 = loadUserConfig();
      assert.notEqual(cfg1, cfg2, 'Should return different object after reset');
    });
  });

  describe('PROFILES', () => {
    it('high profile has all high efforts and thinking enabled', () => {
      const p = PROFILES.high;
      assert.equal(p.opusEffort, 'high');
      assert.equal(p.sonnetEffort, 'high');
      assert.equal(p.codexEffort, 'high');
      assert.equal(p.opusThinking, true);
      assert.equal(p.sonnetThinking, true);
      assert.equal(p.codexThinking, true);
    });

    it('medium profile has opus high, others medium', () => {
      const p = PROFILES.medium;
      assert.equal(p.opusEffort, 'high');
      assert.equal(p.sonnetEffort, 'medium');
      assert.equal(p.codexEffort, 'medium');
      assert.equal(p.opusThinking, true);
      assert.equal(p.sonnetThinking, false);
    });

    it('low profile has reduced efforts', () => {
      const p = PROFILES.low;
      assert.equal(p.opusEffort, 'medium');
      assert.equal(p.sonnetEffort, 'low');
      assert.equal(p.codexEffort, 'low');
      assert.equal(p.opusThinking, false);
    });

    it('all profile names are valid', () => {
      const validNames: EffortLevel[] = ['high', 'medium', 'low'];
      for (const name of validNames) {
        assert.ok(PROFILES[name], `Profile "${name}" should exist`);
      }
    });
  });

  describe('config values are sensible', () => {
    it('relay limits are reasonable', () => {
      const cfg = loadUserConfig();
      assert.ok(cfg.maxRelaysPerWindow >= 10, 'Should allow at least 10 relays');
      assert.ok(cfg.relayWindowMs >= 10_000, 'Window should be at least 10s');
      assert.ok(cfg.maxRelayContentLength >= 1000, 'Content limit should be reasonable');
    });

    it('timeout values are positive', () => {
      const cfg = loadUserConfig();
      assert.ok(cfg.execTimeoutMs > 0, 'Exec timeout should be positive');
    });

    it('circuit breaker threshold is reasonable', () => {
      const cfg = loadUserConfig();
      assert.ok(cfg.circuitBreakerThreshold >= 1, 'Should allow at least 1 failure');
      assert.ok(cfg.circuitBreakerCooldownMs >= 5_000, 'Cooldown should be at least 5s');
    });

    it('models are set', () => {
      const cfg = loadUserConfig();
      assert.ok(cfg.claudeModel.length > 0);
      assert.ok(cfg.opusModel.length > 0);
      assert.ok(cfg.codexModel.length > 0);
    });
  });
});
