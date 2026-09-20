import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, defaultSettings } from '../src/shared/constants.js';
import { KeepAliveEngine } from '../src/shared/keepAliveEngine.js';

/** Deterministic engine with a controllable clock. */
function makeEngine() {
  let now = 1_700_000_000_000;
  const engine = new KeepAliveEngine({ now: () => now });
  return {
    engine,
    advance: (ms) => {
      now += ms;
    },
    time: () => now,
  };
}

const settingsWith = (host = 'app.example.com') => {
  const s = defaultSettings();
  s.sites[host] = { enabled: true };
  return s;
};

test('trackTab returns badge+inject intents only for protected sites', () => {
  const { engine } = makeEngine();
  const s = settingsWith();
  let intents = engine.trackTab(1, 'https://app.example.com/dashboard', s);
  assert.deepEqual(intents.map((i) => i.kind).sort(), ['badge', 'inject']);

  intents = engine.trackTab(2, 'https://random.example.com', s);
  assert.deepEqual(intents, [{ kind: 'badge', tabId: 2, state: 'site-off' }]);

  const off = defaultSettings();
  off.masterEnabled = false;
  intents = engine.trackTab(3, 'https://app.example.com', off);
  assert.deepEqual(intents, [{ kind: 'badge', tabId: 3, state: 'global-off' }]);
});

test('trackTab ignores internal pages and re-validates identical tabs silently', () => {
  const { engine } = makeEngine();
  assert.deepEqual(engine.trackTab(1, 'chrome://settings', defaultSettings()), [], 'internal pages never tracked');
  assert.deepEqual(engine.trackTab(1, 'about:blank', defaultSettings()), []);
  assert.deepEqual(engine.trackTab(1, 'not a url', defaultSettings()), []);
  const s = settingsWith();
  assert.ok(engine.trackTab(1, 'https://app.example.com', s).length > 0);
  assert.deepEqual(engine.trackTab(1, 'https://app.example.com', s), [], 'same tab+url → no re-init');
});

test('tick fires an immediate warm-up on the first tick, then once per interval', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com/x', s);

  advance(10_000); // first tick after tracking
  let intents = engine.tick(s);
  assert.equal(intents.filter((i) => i.kind === 'ping').length, 1, 'protects immediately, not a minute later');

  advance(30_000); // 30s since the ping
  intents = engine.tick(s);
  assert.equal(intents.filter((i) => i.kind === 'ping').length, 0, 'interval not elapsed');

  advance(35_000); // 65s since the ping
  intents = engine.tick(s);
  assert.equal(intents.filter((i) => i.kind === 'ping').length, 1);
});

test('tick simulates activity only when the page is quiet', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com', s);

  engine.noteClientPing(1); // user just active
  advance(LIMITS.activityIntervalSec.min * 1000 - 1_000);
  let intents = engine.tick(s);
  assert.equal(intents.filter((i) => i.kind === 'simulate').length, 0, 'recent client activity → skip');

  advance(2_000); // quiet for 11s ≥ threshold
  intents = engine.tick(s);
  assert.equal(intents.filter((i) => i.kind === 'simulate').length, 1, 'quiet → simulate');

  advance(1_000); // simulated a moment ago
  intents = engine.tick(s);
  assert.equal(intents.filter((i) => i.kind === 'simulate').length, 0, 'does not spam simulation');
});

test('tick sweeps for anti-discard: immediately, then on its slower cadence', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com', s);
  advance(10_000);
  assert.equal(engine.tick(s).filter((i) => i.kind === 'sweep').length, 1, 'first tick sweeps right away');
  advance(3 * 60_000);
  assert.equal(engine.tick(s).filter((i) => i.kind === 'sweep').length, 0, 'cadence not reached');
  advance(2 * 60_000);
  assert.equal(engine.tick(s).filter((i) => i.kind === 'sweep').length, 1, '≈4-minute cadence');
});

test('tick is inert when master switch is off', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com', s);
  advance(10 * 60_000);
  const off = { ...s, masterEnabled: false };
  assert.deepEqual(engine.tick(off), []);
});

test('reportDisconnect schedules exponential-backoff reloads', () => {
  const { engine, advance, time } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com', s);
  advance(1_000);

  let intents = engine.reportDisconnect(1, s, { kind: 'network' });
  let reload = intents.find((i) => i.kind === 'reload');
  assert.ok(reload, 'reload scheduled');
  assert.equal(reload.delayMs, 5_000, 'first attempt: base backoff');
  assert.equal(intents.find((i) => i.kind === 'badge').state, 'recovering');

  advance(6_000);
  intents = engine.reportDisconnect(1, s, {});
  reload = intents.find((i) => i.kind === 'reload');
  assert.equal(reload.delayMs, 10_000, 'second attempt doubles');

  // due reload is re-emitted by tick after the delay passes
  advance(11_000);
  const due = engine.tick(s).filter((i) => i.kind === 'reload');
  assert.equal(due.length, 1);
  assert.ok(time() > 0);
});

test('reportDisconnect gives up after max attempts and clears recovery on success', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com', s);

  engine.reportDisconnect(1, s, {});
  advance(1_000);
  engine.reportDisconnect(1, s, {});
  advance(1_000);
  engine.reportDisconnect(1, s, {});
  const intents = engine.reportDisconnect(1, s, {});
  assert.equal(intents.find((i) => i.kind === 'reload'), undefined, 'budget exhausted (3/3)');
  assert.ok(engine.getLog().some((l) => l.level === 'error'));

  const recovered = engine.noteRecovered(1);
  assert.equal(recovered.find((i) => i.kind === 'badge').state, 'protected');
  advance(10 * 60_000);
  assert.equal(engine.tick(s).filter((i) => i.kind === 'reload').length, 0, 'no more reloads after recovery');
});

test('auto-reload disabled per site → no recovery', () => {
  const { engine } = makeEngine();
  const s = settingsWith();
  s.sites['app.example.com'].autoReload = false;
  engine.trackTab(1, 'https://app.example.com', s);
  assert.equal(engine.reportDisconnect(1, s, {}).length, 0);
});

test('surrender cooldown prevents reload storms during prolonged outages', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com', s);

  // Exhaust the attempt budget → surrender
  for (let i = 0; i < 4; i++) {
    engine.reportDisconnect(1, s, {});
    advance(1_000);
  }
  assert.equal(engine.reportDisconnect(1, s, {}).length, 0, 'budget exhausted');

  // The error-page detector fires again right away → must stay quiet
  assert.deepEqual(engine.reportDisconnect(1, s, { kind: 'error-page' }), [], 'no immediate re-arm after surrender');
  advance(60_000);
  assert.deepEqual(engine.reportDisconnect(1, s, {}), [], 'still cooling down after 1 min');

  // After the cooldown a fresh episode may start
  advance(5 * 60_000);
  const intents = engine.reportDisconnect(1, s, {});
  assert.ok(intents.some((i) => i.kind === 'reload'), 'fresh episode after cooldown');

  // Successful recovery clears the surrender state entirely
  engine.noteRecovered(1);
  assert.equal(engine.surrendered.size, 0, 'surrender cleared on recovery');
});

test('unknown or unprotected tabs are never recovered', () => {
  const { engine } = makeEngine();
  const s = settingsWith();
  assert.deepEqual(engine.reportDisconnect(99, s, {}), []);
  engine.trackTab(1, 'https://random.example.com', s);
  assert.deepEqual(engine.reportDisconnect(1, s, {}), []);
});

test('describeSite exposes countdown and recovery state', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com/dash', s);
  engine.tick(s); // first warm-up ping fires
  advance(20_000);
  const snap = engine.describeSite(s, 'https://app.example.com/dash');
  assert.equal(snap.host, 'app.example.com');
  assert.equal(snap.protectedNow, true);
  assert.equal(snap.tracked, true);
  assert.equal(snap.recovering, false);
  assert.equal(snap.secondsSinceHeartbeat, 20);
  assert.ok(snap.nextHeartbeatInSec > 0 && snap.nextHeartbeatInSec <= 60);
});

test('log is capped and clearable', () => {
  const { engine } = makeEngine();
  for (let i = 0; i < LIMITS.maxLogEntries + 50; i++) engine.push('info', 'logTest', [String(i)]);
  assert.equal(engine.getLog().length, LIMITS.maxLogEntries);
  assert.equal(engine.getLog().at(-1).key, 'logTest');
  assert.deepEqual(engine.getLog().at(-1).params, [String(LIMITS.maxLogEntries + 49)]);
  engine.clearLog();
  assert.equal(engine.getLog().length, 0);
});

test('log entries are structured (i18n key + params), never pre-formatted prose', () => {
  const { engine, advance } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com/x', s);
  engine.reportDisconnect(1, s, { kind: 'network', status: 503 });
  engine.noteRecovered(1);

  for (const entry of engine.getLog()) {
    assert.equal(typeof entry.key, 'string', 'every entry carries an i18n key');
    assert.ok(Array.isArray(entry.params), 'every entry carries substitution params');
    assert.equal(entry.message, undefined, 'no pre-formatted prose in the pure core');
    assert.equal(typeof entry.ts, 'number');
    assert.ok(['info', 'warn', 'error'].includes(entry.level));
  }
  const tracked = engine.getLog().find((l) => l.key === 'logTracking');
  assert.deepEqual(tracked.params, ['app.example.com', '1']);
  const scheduled = engine.getLog().find((l) => l.key === 'logReloadScheduled');
  assert.equal(scheduled.params[0], 'app.example.com');
  assert.equal(scheduled.params[1], 'network 503', 'reason keeps kind + status');
  advance(1000);
});

test('notifyOnReload emits a localized notify intent on the first attempt only', () => {
  const { engine } = makeEngine();
  const s = settingsWith();
  s.sites['app.example.com'].notifyOnReload = true;
  engine.trackTab(1, 'https://app.example.com/x', s);

  const first = engine.reportDisconnect(1, s, { kind: 'network' });
  const note = first.find((i) => i.kind === 'notify');
  assert.ok(note, 'notification intent on first attempt');
  assert.equal(note.titleKey, 'notifyTitle');
  assert.equal(note.messageKey, 'notifyReconnect');
  assert.deepEqual(note.messageParams, ['app.example.com']);
  assert.equal(note.message, undefined, 'no pre-formatted prose');

  const second = engine.reportDisconnect(1, s, {});
  assert.equal(second.find((i) => i.kind === 'notify'), undefined, 'no notification on later attempts');
});

test('untrackTab forgets the tab entirely', () => {
  const { engine } = makeEngine();
  const s = settingsWith();
  engine.trackTab(1, 'https://app.example.com', s);
  engine.reportDisconnect(1, s, {});
  engine.untrackTab(1);
  assert.equal(engine._tabCount(), 0);
  advanceTicks(engine, s, 5);
  assert.equal(engine.tick(s).filter((i) => i.kind === 'reload').length, 0);
});

function advanceTicks(engine, s, n) {
  for (let i = 0; i < n; i++) engine.tick(s);
}
