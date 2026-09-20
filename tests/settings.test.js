import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, defaultSettings } from '../src/shared/constants.js';
import { SettingsStore, memoryStorage, normalizeBehavior, normalizeSettings } from '../src/shared/settings.js';

test('normalizeBehavior fills defaults and drops unknown keys', () => {
  const b = normalizeBehavior({ heartbeat: false, bogus: 'x', heartbeatIntervalSec: 5, heartbeatMethod: 'trace' });
  assert.equal(b.heartbeat, false);
  assert.equal(b.heartbeatIntervalSec, LIMITS.heartbeatIntervalSec.min); // clamped up
  assert.equal(b.heartbeatMethod, 'head'); // invalid → default
  assert.equal('bogus' in b, false);
  assert.equal(b.autoReload, true);
});

test('normalizeBehavior clamps extremes', () => {
  const b = normalizeBehavior({ heartbeatIntervalSec: 99_999, reloadMaxAttempts: 0 });
  assert.equal(b.heartbeatIntervalSec, LIMITS.heartbeatIntervalSec.max);
  assert.equal(b.reloadMaxAttempts, LIMITS.reloadMaxAttempts.min);
});

test('normalizeBehavior tolerates non-objects', () => {
  assert.deepEqual(normalizeBehavior(null), normalizeBehavior({}));
  assert.deepEqual(normalizeBehavior('nope'), normalizeBehavior(undefined));
});

test('normalizeSettings restores full tree from partial data', () => {
  const s = normalizeSettings({
    masterEnabled: false,
    sites: { 'https://App.Example.com/x': { enabled: true, heartbeatIntervalSec: 45 } },
    recovery: { backoffBaseSec: 1_000 }, // clamped
  });
  assert.equal(s.masterEnabled, false);
  const site = s.sites['app.example.com'];
  assert.ok(site, 'site key normalized to bare hostname');
  assert.equal(site.enabled, true);
  assert.equal(site.heartbeatIntervalSec, 45);
  assert.equal(site.heartbeat, true); // default filled in
  assert.equal(s.recovery.backoffBaseSec, LIMITS.reloadBackoffBaseSec.max);
});

test('normalizeSettings drops invalid sites and log entries', () => {
  const s = normalizeSettings({
    sites: { 'not a url!!': { enabled: true }, 'ok.example.com': { enabled: true } },
    log: [null, { ts: 1, message: 'kept' }, { message: 42 }, { ts: 'x', level: 'warn', message: 'ts fixed' }],
  });
  assert.deepEqual(Object.keys(s.sites), ['ok.example.com']);
  assert.equal(s.log.length, 2);
  assert.equal(typeof s.log[1].ts, 'number');
});

test('normalizeSettings caps the log length', () => {
  const log = Array.from({ length: LIMITS.maxLogEntries + 100 }, (_, i) => ({ ts: i, message: `m${i}` }));
  const s = normalizeSettings({ log });
  assert.equal(s.log.length, LIMITS.maxLogEntries);
  assert.equal(s.log.at(-1).message, `m${LIMITS.maxLogEntries + 99}`);
});

test('memoryStorage stores and removes', async () => {
  const storage = memoryStorage();
  await storage.set({ a: 1, b: 2 });
  assert.deepEqual(await storage.get(['a', 'missing']), { a: 1 });
  await storage.remove(['a']);
  assert.deepEqual(await storage.get(['a']), {});
});

test('SettingsStore roundtrips through load/save/update', async () => {
  const store = new SettingsStore(memoryStorage());
  const loaded = await store.load();
  assert.equal(loaded.masterEnabled, true); // defaults on empty storage

  await store.save({ masterEnabled: false, sites: { 'example.com': { enabled: true } } });
  const again = await store.load();
  assert.equal(again.masterEnabled, false);
  assert.equal(again.sites['example.com'].enabled, true);
  // site behavior fully populated after normalization
  assert.equal(typeof again.sites['example.com'].heartbeatIntervalSec, 'number');

  const updated = await store.update((s) => {
    s.masterEnabled = true;
    return s;
  });
  assert.equal(updated.masterEnabled, true);
});

test('SettingsStore never rejects on corrupt storage', async () => {
  const bad = {
    async get() {
      throw new Error('boom');
    },
    async set() {
      throw new Error('boom');
    },
  };
  const store = new SettingsStore(bad);
  const loaded = await store.load();
  assert.deepEqual(loaded, normalizeSettings(defaultSettings()));
  await assert.rejects(() => store.save({}));
});
