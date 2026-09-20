/**
 * Keurweb — Keep Your Web
 * Shared constants: defaults, limits and message channel names.
 * Pure data — no browser APIs — so it can be unit-tested in Node.
 */

/** Extension display name. */
export const APP_NAME = 'Keurweb';

/** Current version reported by the About panel (kept in sync with manifest). */
export const APP_VERSION = '1.0.0';

/** Message action names used between popup/options/content and the worker. */
export const MSG = Object.freeze({
  GET_STATE: 'getState',
  TOGGLE_SITE: 'toggleSite',
  SET_GLOBAL: 'setGlobal',
  SET_SITE_BEHAVIOR: 'setSiteBehavior',
  KEEPALIVE_NOW: 'keepaliveNow',
  ACTIVITY_PING: 'activityPing',
  DISCONNECT_REPORT: 'disconnectReport',
  RESET_SETTINGS: 'resetSettings',
  EXPORT_SETTINGS: 'exportSettings',
  IMPORT_SETTINGS: 'importSettings',
  GET_LOG: 'getLog',
  LOG_CLEARED: 'logCleared',
  OPEN_OPTIONS: 'openOptions',
  SETTINGS_CHANGED: 'settingsChanged',
});

/** Default per-site behavior knobs. Range limits live in limits. */
export const DEFAULT_SITE_BEHAVIOR = Object.freeze({
  heartbeat: true,
  heartbeatIntervalSec: 60,
  heartbeatMethod: 'head', // 'head' | 'get'
  activity: true,
  activityMode: 'events', // 'events' | 'focus' | 'both'
  antiDiscard: true,
  autoReload: true,
  reloadMaxAttempts: 3,
  notifyOnReload: false,
});

/** Hard limits applied to every editable number in the options UI. */
export const LIMITS = Object.freeze({
  heartbeatIntervalSec: { min: 15, max: 3600 },
  reloadMaxAttempts: { min: 1, max: 10 },
  reloadBackoffBaseSec: { min: 2, max: 60 },
  reloadBudgetMin: { min: 5, max: 240 },
  activityIntervalSec: { min: 10, max: 600 },
  maxLogEntries: 500,
  maxManagedTabs: 500,
});

/**
 * Factory defaults for the whole configuration tree.
 * Returns a fresh, mutable object on every call — callers own their copy
 * (normalizeSettings fills/validates the shape before anything is stored).
 */
export function defaultSettings() {
  return {
    masterEnabled: true,
    defaults: { ...DEFAULT_SITE_BEHAVIOR },
    /** Per-site overrides keyed by normalized origin (e.g. "app.example.com"). */
    sites: {},
    /** Recovery tuning shared by all sites. */
    recovery: {
      backoffBaseSec: 5,
      budgetMin: 30,
    },
    /** Diagnostics log of keep-alive and recovery events. */
    log: [],
  };
}

/** Every switchable behavior key (grouped by feature for readability). */
export const ALL_BEHAVIOR_KEYS = Object.freeze([
  // session heartbeat
  'heartbeat',
  'heartbeatIntervalSec',
  'heartbeatMethod',
  // anti-idle activity
  'activity',
  'activityMode',
  // auto-reconnect
  'autoReload',
  'reloadMaxAttempts',
  'notifyOnReload',
  // anti-discard
  'antiDiscard',
]);

/**
 * Normalizes any URL-ish string to a bare hostname used as the site key.
 * Returns '' for inputs without a parseable hostname (scheme-relative URLs,
 * plain paths, empty strings).
 * @param {string} input
 * @returns {string}
 */
export function normalizeSiteKey(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname) return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}
