import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SITE_BEHAVIOR, LIMITS, MSG, normalizeSiteKey, defaultSettings, ALL_BEHAVIOR_KEYS } from '../src/shared/constants.js';

test('normalizeSiteKey trims, lowercases and strips scheme/path', () => {
  assert.equal(normalizeSiteKey('https://App.Example.com/path?q=1'), 'app.example.com');
  assert.equal(normalizeSiteKey('  EXAMPLE.com  '), 'example.com');
  assert.equal(normalizeSiteKey('http://localhost:3000/x'), 'localhost');
  assert.equal(normalizeSiteKey('//cdn.example.com'), 'cdn.example.com', 'protocol-relative input is accepted');
});

test('normalizeSiteKey rejects garbage', () => {
  assert.equal(normalizeSiteKey(''), '');
  assert.equal(normalizeSiteKey(null), '');
  assert.equal(normalizeSiteKey('   '), '');
  assert.equal(normalizeSiteKey('http://'), '');
});

test('defaultSettings is complete and fresh per call', () => {
  const a = defaultSettings();
  const b = defaultSettings();
  assert.equal(a.masterEnabled, true);
  assert.equal(typeof a.defaults.heartbeat, 'boolean');
  assert.deepEqual(a.recovery, { backoffBaseSec: 5, budgetMin: 30 });
  a.defaults.heartbeatIntervalSec = 999;
  a.sites['x.example.com'] = { enabled: true };
  assert.equal(b.defaults.heartbeatIntervalSec, 60, 'mutating one copy must not leak into another');
  assert.equal(Object.keys(b.sites).length, 0);
});

test('DEFAULT_SITE_BEHAVIOR covers every switchable key', () => {
  for (const key of ALL_BEHAVIOR_KEYS) {
    assert.ok(key in DEFAULT_SITE_BEHAVIOR, `missing behavior key: ${key}`);
  }
});

test('message names are unique', () => {
  const names = Object.values(MSG);
  assert.equal(new Set(names).size, names.length);
});

test('limits are sane', () => {
  assert.ok(LIMITS.heartbeatIntervalSec.min >= 10, 'heartbeat must not hammer servers');
  assert.ok(LIMITS.maxLogEntries > 0);
  assert.ok(LIMITS.maxManagedTabs > 0);
});
