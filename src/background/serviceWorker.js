/**
 * Keurweb — Keep Your Web — MV3 service worker.
 *
 * Binds the pure KeepAliveEngine to chrome.* APIs:
 *  - persists settings via SettingsStore (chrome.storage.local)
 *  - tracks http(s) tabs and resolves per-site behavior
 *  - runs a 1-minute alarm tick that emits heartbeat / activity /
 *    anti-discard / recovery intents
 *  - performs warm-up pings, injects the content script, reloads dead tabs
 *  - renders toolbar badge state
 *
 * The worker holds no business logic — everything decidable is in
 * shared/keepAliveEngine.js and shared/policy.js.
 */

import { KeepAliveEngine } from '../shared/keepAliveEngine.js';
import { LIMITS, MSG, normalizeSiteKey } from '../shared/constants.js';
import { SettingsStore } from '../shared/settings.js';
import { badgeFor, resolveBehavior, shouldProtect } from '../shared/policy.js';

const TICK_ALARM = 'keurweb-tick';
const HEARTBEAT_FAILS_BEFORE_RELOAD = 2;
const ERROR_PAGE_URL = 'chrome-error://chromewebdata/';

const store = new SettingsStore(chrome.storage.local);
const engine = new KeepAliveEngine();

/**
 * Persists the stat counters the engine mutated on a settings tree.
 * Stats live in chrome.storage.local (durable + exportable), unlike tab
 * state which only needs storage.session.
 */
async function persistStats(settings) {
  await store.update((s) => {
    s.stats = settings.stats;
    return s;
  });
}

/**
 * Runs reportDisconnect and persists stats when a reload was scheduled
 * (that's the only path that mutates lastDisconnectAt).
 */
async function disconnectAndPersist(tabId, settings, detail) {
  const intents = engine.reportDisconnect(tabId, settings, detail);
  await runIntents(intents);
  if (intents.some((i) => i.kind === 'reload')) await persistStats(settings);
  return intents;
}

/** tabId -> {state, title} for the active-tab badge. */
const badgeState = new Map();
/** tabId -> consecutive heartbeat failures. */
const heartbeatFails = new Map();
/** tabId -> pending reload setTimeout handle. */
const pendingReloads = new Map();
/** Tabs we told Chrome to reload while recovering (to flag completion). */
const recoveringTabs = new Set();

// --------------------------------------------------------------------------
// Badge

async function paintBadge(tabId, state) {
  const { text, color, titleKey } = badgeFor(state);
  badgeState.set(tabId, state);
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setTitle({ tabId, title: chrome.i18n.getMessage(titleKey) || 'Keurweb' });
  } catch {
    /* tab closed before paint — ignore */
  }
}

/**
 * Shows a desktop notification (only fires for sites with
 * "notify when reconnecting" turned on).
 */
function notify(titleKey, messageKey, messageParams) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'assets/icons/icon128.png',
      title: chrome.i18n.getMessage(titleKey),
      message: chrome.i18n.getMessage(messageKey, messageParams ?? []),
    });
  } catch {
    /* notifications unavailable in this context — ignore */
  }
}

// --------------------------------------------------------------------------
// Intents

async function runIntents(intents) {
  for (const intent of intents) {
    try {
      switch (intent.kind) {
        case 'badge':
          await paintBadge(intent.tabId, intent.state);
          break;
        case 'ping':
          void performHeartbeat(intent.tabId, intent.url, intent.method);
          break;
        case 'simulate':
          await sendToTab(intent.tabId, { cmd: 'keurweb-simulate', mode: currentMode(intent.host) });
          break;
        case 'sweep':
          await sweepTab(intent.tabId);
          break;
        case 'inject':
          await injectIntoTab(intent.tabId);
          break;
        case 'reload':
          scheduleReload(intent.tabId, intent.delayMs);
          break;
        case 'notify':
          notify(intent.titleKey, intent.messageKey, intent.messageParams);
          break;
        default:
          break;
      }
    } catch (error) {
      console.warn('[keurweb] intent failed:', intent.kind, error?.message ?? error);
    }
  }
}

async function currentMode(host) {
  const settings = await store.load();
  const { behavior } = resolveBehavior(settings, host);
  return behavior.activityMode;
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* receiver gone — next tick will re-inject if needed */
  }
}

/**
 * Anti-discard sweep: refreshes the tab's metadata and pokes the page with a
 * focus event. Together with the heartbeats (which keep network activity up)
 * this discourages Brave's Memory Saver from freezing the tab.
 */
async function sweepTab(tabId) {
  try {
    await chrome.tabs.get(tabId); // refresh recency metadata
    await chrome.tabs.sendMessage(tabId, { cmd: 'keurweb-simulate', mode: 'focus' });
  } catch {
    /* ignore */
  }
}

// --------------------------------------------------------------------------
// Heartbeat (worker-side warm-up ping)

async function performHeartbeat(tabId, url, method = 'HEAD') {
  try {
    await fetch(url, {
      method,
      mode: 'no-cors',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    });
    heartbeatFails.delete(tabId);
  } catch {
    const fails = (heartbeatFails.get(tabId) ?? 0) + 1;
    heartbeatFails.set(tabId, fails);
    if (fails >= HEARTBEAT_FAILS_BEFORE_RELOAD) {
      heartbeatFails.delete(tabId);
      const settings = await store.load();
      await disconnectAndPersist(tabId, settings, { kind: 'heartbeat' });
    }
  }
}

// --------------------------------------------------------------------------
// Recovery reloads

function scheduleReload(tabId, delayMs) {
  if (pendingReloads.has(tabId)) return; // a reload is already queued
  const handle = setTimeout(async () => {
    pendingReloads.delete(tabId);
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url || '';
      // chrome-error:// pages must be reloadable — that's how a failed
      // navigation is retried. Discarded tabs are skipped (the anti-discard
      // sweep handles those separately).
      const reloadable = url.startsWith('http') || url.startsWith('chrome-error:');
      if (!tab.discarded && reloadable) {
        recoveringTabs.add(tabId);
        await chrome.tabs.reload(tabId);
      }
    } catch {
      /* tab vanished — engine will notice via onRemoved */
    }
  }, Math.max(0, delayMs));
  pendingReloads.set(tabId, handle);
}

// --------------------------------------------------------------------------
// Content-script injection

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/contentScript.js'],
    });
  } catch {
    /* not injectable yet (still loading / restricted page) — retried on tick */
  }
}

// --------------------------------------------------------------------------
// Tab lifecycle

async function considerTab(tabId, url, status) {
  const settings = await store.load();

  // Chrome's error page is not http(s), so this must run before the
  // protocol gate — otherwise failed loads are untracked and never recovered.
  if (url === ERROR_PAGE_URL) {
    await disconnectAndPersist(tabId, settings, { kind: 'error-page' });
    return;
  }

  if (!url || !/^https?:/i.test(url)) {
    if (engine.getTab(tabId)) engine.untrackTab(tabId);
    return;
  }

  const known = engine.getTab(tabId);

  // Tab finished loading after a recovery reload?
  if (status === 'complete' && recoveringTabs.has(tabId)) {
    recoveringTabs.delete(tabId);
    const intents = engine.noteRecovered(tabId, settings);
    await runIntents(intents);
    if (settings.stats) await persistStats(settings);
    await injectIntoTab(tabId);
    return;
  }

  if (!shouldProtect(settings, url)) {
    if (known) engine.untrackTab(tabId);
    await paintBadge(tabId, settings.masterEnabled ? 'site-off' : 'global-off');
    return;
  }

  const intents = engine.trackTab(tabId, url, settings);
  await runIntents(intents);
  // Refresh the badge once tracking state is known.
  if (intents.length === 0) await paintBadge(tabId, 'protected');
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? tab.url;
  if (changeInfo.status || changeInfo.url) void considerTab(tabId, url, changeInfo.status);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const handle = pendingReloads.get(tabId);
  if (handle) clearTimeout(handle);
  pendingReloads.delete(tabId);
  heartbeatFails.delete(tabId);
  badgeState.delete(tabId);
  recoveringTabs.delete(tabId);
  engine.untrackTab(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const state = badgeState.get(tabId);
  if (state) await paintBadge(tabId, state);
});

// --------------------------------------------------------------------------
// Messages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((response) => sendResponse(response ?? {}))
    .catch((error) => sendResponse({ error: String(error?.message ?? error) }));
  return true; // async response
});

async function activeTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function handleMessage(message, sender = {}) {
  const type = message?.type;
  if (!type) return {};

  switch (type) {
    case MSG.GET_STATE: {
      const settings = await store.load();
      const tab = await activeTabContext();
      const url = tab?.url ?? '';
      if (!url || !/^https?:/i.test(url)) {
        return { supported: false, masterEnabled: settings.masterEnabled, snapshot: null };
      }
      return { supported: true, masterEnabled: settings.masterEnabled, tabUrl: url, snapshot: engine.describeSite(settings, url) };
    }

    case MSG.TOGGLE_SITE: {
      const settings = await store.load();
      const tab = await activeTabContext();
      const url = message.url ?? tab?.url ?? '';
      const host = message.host
        ? normalizeSiteKey(message.host)
        : url
          ? new URL(url).hostname.toLowerCase()
          : '';
      if (!host) return { error: 'host required' };
      // Toggling works on the exact host. When the host is only covered by a
      // wildcard rule, the first toggle creates an exact override
      // (enabled = !currently-protected) so a single site can be paused
      // without touching the rest of the family.
      const { siteEnabled } = resolveBehavior(settings, host);
      const saved = await store.update((s) => {
        if (s.sites[host]) {
          s.sites[host].enabled = !s.sites[host].enabled;
        } else {
          s.sites[host] = { enabled: !siteEnabled };
        }
        return s;
      });
      const nowEnabled = saved.sites[host]?.enabled === true;
      engine.push('info', nowEnabled ? 'logToggledOn' : 'logToggledOff', [host]);
      await resyncAllTabs();
      return { host, enabled: nowEnabled };
    }

    case MSG.SET_GLOBAL: {
      await store.update((s) => {
        s.masterEnabled = message.enabled === true;
        return s;
      });
      await resyncAllTabs();
      return { enabled: message.enabled === true };
    }

    case MSG.SET_SITE_BEHAVIOR: {
      const { host, patch } = message;
      if (typeof host !== 'string' || !patch || typeof patch !== 'object') {
        return { error: 'host and patch required' };
      }
      const saved = await store.update((s) => {
        if (!s.sites[host]) s.sites[host] = { enabled: true };
        Object.assign(s.sites[host], patch);
        return s;
      });
      return { ok: true, site: saved.sites[host] ?? null };
    }

    case MSG.ACTIVITY_PING: {
      const tabId = sender?.tab?.id;
      if (Number.isInteger(tabId)) engine.noteClientPing(tabId);
      return {};
    }

    case MSG.DISCONNECT_REPORT: {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) return {};
      const settings = await store.load();
      await disconnectAndPersist(tabId, settings, message.detail ?? {});
      return {};
    }

    case MSG.KEEPALIVE_NOW: {
      const settings = await store.load();
      const tab = await activeTabContext();
      if (tab?.id && tab.url && shouldProtect(settings, tab.url)) {
        const intents = engine.pingNow(tab.id, settings, tab.url);
        await runIntents(intents);
        if (intents.length) await persistStats(settings);
        await sendToTab(tab.id, { cmd: 'keurweb-simulate', mode: 'both' });
      }
      return {};
    }

    case MSG.RESET_SETTINGS: {
      await store.save({});
      await resetEngineState();
      await resyncAllTabs();
      return { ok: true };
    }

    case MSG.EXPORT_SETTINGS: {
      const settings = await store.load();
      return { payload: JSON.stringify({ kind: 'keurweb-settings', version: 1, settings }, null, 2) };
    }

    case MSG.IMPORT_SETTINGS: {
      const raw = String(message.payload ?? '');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { error: 'Invalid JSON' };
      }
      if (parsed?.kind !== 'keurweb-settings' || typeof parsed.settings !== 'object') {
        return { error: 'Not a Keurweb export file' };
      }
      await store.save(parsed.settings);
      await resetEngineState();
      await resyncAllTabs();
      return { ok: true };
    }

    case MSG.LOG_CLEARED: {
      engine.clearLog();
      return { ok: true };
    }

    case MSG.GET_LOG: {
      return { log: engine.getLog() };
    }

    case MSG.SETTINGS_CHANGED: {
      await resyncAllTabs();
      return { ok: true };
    }

    case MSG.OPEN_OPTIONS: {
      await chrome.runtime.openOptionsPage();
      return {};
    }

    default:
      return { error: `Unknown message: ${type}` };
  }
}

async function resetEngineState() {
  for (const handle of pendingReloads.values()) clearTimeout(handle);
  pendingReloads.clear();
  heartbeatFails.clear();
  recoveringTabs.clear();
  for (const tab of engine.getTrackedTabs()) engine.untrackTab(tab.tabId);
  engine.clearLog();
}

/** Re-evaluates every open tab against the (new) settings. */
async function resyncAllTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs.slice(0, LIMITS.maxManagedTabs)) {
    if (Number.isInteger(tab.id)) await considerTab(tab.id, tab.url, 'complete');
  }
}

// --------------------------------------------------------------------------
// Commands

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-for-active-tab') return;
  const tab = await activeTabContext();
  if (!tab?.url || !/^https?:/i.test(tab.url)) return;
  await handleMessage({ type: MSG.TOGGLE_SITE, url: tab.url });
});

// --------------------------------------------------------------------------
// Alarm tick + lifecycle

async function runTick() {
  const settings = await store.load();
  const statsBefore = JSON.stringify(settings.stats);
  const intents = engine.tick(settings);
  await runIntents(intents);
  if (JSON.stringify(settings.stats) !== statsBefore) await persistStats(settings);
  persistSession();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void runTick();
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  await resyncAllTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreSession();
  await resyncAllTabs();
});

// --------------------------------------------------------------------------
// Session persistence (survives worker restarts via storage.session)

let persistTimer = null;
function persistSession() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const tabs = engine
      .getTrackedTabs()
      .map(({ tabId, host, url, addedAt }) => ({ tabId, host, url, addedAt }));
    void chrome.storage.session.set({ trackedTabs: tabs }).catch(() => {});
  }, 1000);
}

async function restoreSession() {
  try {
    const data = await chrome.storage.session.get(['trackedTabs']);
    const settings = await store.load();
    for (const rec of Array.isArray(data?.trackedTabs) ? data.trackedTabs : []) {
      if (Number.isInteger(rec?.tabId) && typeof rec?.url === 'string') {
        runIntents(engine.trackTab(rec.tabId, rec.url, settings));
      }
    }
  } catch {
    /* storage.session unavailable — cold start is fine */
  }
}

// Boot: restore anything persisted from a previous worker lifetime.
restoreSession();
