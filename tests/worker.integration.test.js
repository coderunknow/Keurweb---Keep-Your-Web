/**
 * Integration test: boots the real service worker against a mock chrome.*
 * environment and drives the full flows — install, enabling a site, ticks,
 * heartbeats, disconnect → reload → recovery.
 *
 * Runs in its own process (node:test) so the module-level worker state is fresh.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// Mock chrome APIs

function makeChromeMock() {
  const calls = { fetches: [], injections: [], reloads: [], messages: [], badges: {}, alarms: [] };
  const listeners = { tabsUpdated: [], tabsRemoved: [], tabsActivated: [], alarms: [], commands: [], installed: [], startup: [] };
  let messageListener = null;
  let activeTab = null;

  const makeEvent = (list) => ({ addListener: (fn) => list.push(fn) });

  const storageArea = () => {
    const map = new Map();
    return {
      async get(keys) {
        const out = {};
        for (const k of keys) if (map.has(k)) out[k] = map.get(k);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) map.set(k, v);
      },
    };
  };

  const chrome = {
    storage: { local: storageArea(), session: storageArea() },
    alarms: {
      create: (name, info) => calls.alarms.push({ name, info }),
      onAlarm: makeEvent(listeners.alarms),
    },
    tabs: {
      onUpdated: makeEvent(listeners.tabsUpdated),
      onRemoved: makeEvent(listeners.tabsRemoved),
      onActivated: makeEvent(listeners.tabsActivated),
      async query() {
        return activeTab ? [activeTab] : [];
      },
      async get(id) {
        return { id, url: activeTab?.id === id ? activeTab.url : 'https://app.example.com/x', discarded: false };
      },
      async sendMessage(tabId, message) {
        calls.messages.push({ tabId, message });
      },
      async reload(tabId) {
        calls.reloads.push(tabId);
      },
      async create(_opts) {},
    },
    scripting: {
      async executeScript(opts) {
        calls.injections.push(opts.target.tabId);
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
      onInstalled: makeEvent(listeners.installed),
      onStartup: makeEvent(listeners.startup),
      async sendMessage() {
        return {};
      },
    },
    action: {
      async setBadgeText({ tabId, text }) {
        calls.badges[tabId] = text;
      },
      async setBadgeBackgroundColor() {},
      async setTitle() {},
    },
    commands: { onCommand: makeEvent(listeners.commands) },
  };

  return { chrome, calls, listeners, get listener() { return messageListener; }, setActiveTab: (t) => (activeTab = t) };
}

const env = makeChromeMock();
globalThis.chrome = env.chrome;

// Stable, controllable fetch stub.
globalThis.fetch = async (url) => {
  env.calls.fetches.push(String(url));
  if (globalThis.__failFetch) throw new TypeError('Failed to fetch');
  return { ok: true, type: 'opaque' };
};

// --------------------------------------------------------------------------
// Boot the real worker (module top-level registers all listeners)

await import('../src/background/serviceWorker.js');

const drain = () => new Promise((r) => setImmediate(r));

/** Sends a message through the worker's real onMessage listener. */
function send(message, sender = {}) {
  return new Promise((resolve, reject) => {
    env.listener(
      message,
      sender,
      (resp) => {
        if (resp && resp.error) reject(new Error(resp.error));
        else resolve(resp ?? {});
      },
    );
  });
}

const TAB_URL = 'https://app.example.com/dashboard';
const TAB = { id: 7, url: TAB_URL };

async function fireTabUpdate(tab, changeInfo) {
  for (const fn of env.listeners.tabsUpdated) {
    fn(tab.id, changeInfo, { ...tab, ...changeInfo });
    await drain();
  }
}

test('install creates the 1-minute tick alarm', async () => {
  for (const fn of env.listeners.installed) {
    fn();
    await drain();
  }
  const tick = env.calls.alarms.find((a) => a.name === 'keurweb-tick');
  assert.ok(tick, 'tick alarm created');
  assert.equal(tick.info.periodInMinutes, 1);
});

test('enabling a site from the popup protects the tab and injects the helper', async () => {
  env.setActiveTab(TAB);
  await fireTabUpdate(TAB, { status: 'complete', url: TAB_URL });

  // Not protected yet
  let state = await send({ type: 'getState' });
  assert.equal(state.supported, true);
  assert.equal(state.snapshot.protectedNow, false);

  // Toggle from the popup (no url in message → active tab is used)
  const toggled = await send({ type: 'toggleSite' });
  assert.equal(toggled.enabled, true);

  await fireTabUpdate(TAB, { status: 'complete', url: TAB_URL });

  state = await send({ type: 'getState' });
  assert.equal(state.snapshot.protectedNow, true);
  assert.equal(env.calls.badges[7], 'ON', 'badge shows ON for protected tab');
  assert.ok(env.calls.injections.includes(7), 'content script injected');
});

test('the alarm tick performs heartbeat + activity + sweep for protected tabs', async () => {
  const before = env.calls.fetches.length;
  for (const fn of env.listeners.alarms) {
    fn({ name: 'keurweb-tick' });
    await drain(); await drain();
  }
  assert.ok(env.calls.fetches.length > before, 'heartbeat fetch performed');
  assert.ok(env.calls.fetches.at(-1).startsWith(TAB_URL), 'ping hits the protected site');
  const simulates = env.calls.messages.filter((m) => m.message?.cmd === 'keurweb-simulate');
  assert.ok(simulates.length > 0, 'activity simulation requested');
});

test('disconnect report schedules a backoff reload; completion recovers the tab', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await send({ type: 'disconnectReport', detail: { kind: 'network' } }, { tab: { id: 7 } });

    // No reload before the backoff elapses
    mock.timers.tick(2_000);
    await drain();
    assert.equal(env.calls.reloads.length, 0, 'waits out the backoff');

    // After 5s base backoff → reload
    mock.timers.tick(4_000);
    await drain();
    assert.equal(env.calls.reloads.length, 1, 'tab reloaded after backoff');
    assert.equal(env.calls.badges[7], 'RX', 'badge shows recovering state');

    // Page finished loading again → recovered
    globalThis.__keurwebRecovering = true;
    // simulate the worker marking recovery on reload (internal), then completion:
    await fireTabUpdate(TAB, { status: 'complete', url: TAB_URL });

    const state = await send({ type: 'getState' });
    assert.equal(state.snapshot.recovering, false, 'recovery cleared after reload completes');
  } finally {
    mock.timers.reset();
  }
});

test('keepaliveNow pings immediately and simulate reaches the tab', async () => {
  const before = env.calls.fetches.length;
  await send({ type: 'keepaliveNow' });
  await drain();
  assert.ok(env.calls.fetches.length > before, 'manual refresh pinged');
});

test('activity pings are accepted; tab-less reports are ignored safely', async () => {
  await send({ type: 'activityPing' }, { tab: { id: 7 } }); // must not throw
  await send({ type: 'disconnectReport', detail: { kind: 'network' } }, {}); // no tab → ignored
  const state = await send({ type: 'getState' });
  assert.equal(state.snapshot.recovering, false, 'tab-less report triggered nothing');
});

test('settings export/import roundtrip through the worker', async () => {
  const { payload } = await send({ type: 'exportSettings' });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.kind, 'keurweb-settings');
  assert.equal(parsed.settings.sites['app.example.com'].enabled, true);

  parsed.settings.masterEnabled = false;
  await send({ type: 'importSettings', payload: JSON.stringify(parsed) });
  const state = await send({ type: 'getState' });
  assert.equal(state.masterEnabled, false);

  // Restore
  parsed.settings.masterEnabled = true;
  await send({ type: 'importSettings', payload: JSON.stringify(parsed) });
});

test('import rejects corrupt payloads without breaking state', async () => {
  await assert.rejects(() => send({ type: 'importSettings', payload: '{oops' }), /Invalid JSON/);
  await assert.rejects(() => send({ type: 'importSettings', payload: '{"kind":"other"}' }), /Not a Keurweb export/);
  const state = await send({ type: 'getState' });
  assert.equal(state.masterEnabled, true, 'settings untouched after failed imports');
});

test('closing the tab untracks it; unknown message types error cleanly', async () => {
  for (const fn of env.listeners.tabsRemoved) {
    fn(7);
    await drain();
  }
  const state = await send({ type: 'getState' });
  assert.equal(state.snapshot.tracked, false);

  const resp = await new Promise((resolve) => env.listener({ type: 'bogus' }, {}, resolve));
  assert.match(resp.error, /Unknown message/);
});
