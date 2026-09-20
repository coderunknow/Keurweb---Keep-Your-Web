/**
 * Keurweb — Keep Your Web
 * Shared constants: defaults, limits and message channel names.
 * Pure data — no browser APIs — so it can be unit-tested in Node.
 */

/** Extension display name. */
export const APP_NAME = 'Keurweb';

/** Current version reported by the About panel (kept in sync with manifest). */
export const APP_VERSION = '1.2.0';

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
  maxLogEntries: 500,
  maxManagedTabs: 500,
});

/**
 * Quiet-gate threshold for activity simulation: the engine only simulates
 * activity when the page has had no client activity for this long (ms).
 * This is a fixed behavioral constant, not a user-facing knob — the old
 * LIMITS.activityIntervalSec entry (min 10, max 600) was validated but
 * never consumed by any UI control, so it is removed to avoid confusion.
 * The 10s value is preserved as the quiet-gate semantics.
 */
export const ACTIVITY_QUIET_MS = 10_000;

/**
 * Factory defaults for the whole configuration tree.
 * Returns a fresh, mutable object on every call — callers own their copy
 * (normalizeSettings fills/validates the shape before anything is stored).
 */
export function defaultSettings() {
  return {
    masterEnabled: true,
    defaults: { ...DEFAULT_SITE_BEHAVIOR },
    /** Per-site overrides keyed by site rule (exact host or "*.host" wildcard). */
    sites: {},
    /**
     * Per-rule counters, e.g.
     * { "app.example.com": { heartbeats, recoveries, lastHeartbeatAt,
     *   lastDisconnectAt, lastRecoverAt } }. 0 = never happened.
     */
    stats: {},
    /** Recovery tuning shared by all sites. */
    recovery: {
      backoffBaseSec: 5,
      budgetMin: 30,
    },
    /** Daily quiet-hours window: protection is paused during this period. */
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
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

/** Prefix marking a wildcard (subdomain) site rule, e.g. "*.example.com". */
export const WILDCARD_PREFIX = '*.';

/**
 * Bare-hostname charset after URL parsing: DNS labels, IPv6 addresses and
 * single-label hosts (localhost). Wildcards are rejected here on purpose —
 * wildcard rules go through normalizeSiteRule.
 */
const HOSTNAME_RE = /^[a-z0-9:\-._]+$/i;

/**
 * Normalizes any URL-ish string to a bare hostname used as an exact-match
 * site key. Returns '' for inputs without a parseable hostname
 * (scheme-relative URLs, plain paths, empty strings, wildcard input).
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
    const host = url.hostname.toLowerCase();
    if (!host || host.includes('*') || !HOSTNAME_RE.test(host)) return '';
    return host;
  } catch {
    return '';
  }
}

/**
 * True when a stored site rule is a wildcard subdomain rule ("*.example.com").
 * @param {string} rule
 */
export function isWildcardRule(rule) {
  return (
    typeof rule === 'string' &&
    rule.startsWith(WILDCARD_PREFIX) &&
    !rule.slice(WILDCARD_PREFIX.length).includes('*')
  );
}

/**
 * Normalizes user input into a site rule key: an exact hostname
 * ("example.com") or a wildcard rule ("*.example.com").
 *
 * A wildcard rule requires at least two labels after the asterisk
 * ("*.example.com"), so over-broad rules like "*.com" are rejected.
 * Returns '' when the input is not a usable site rule.
 * @param {string} input
 * @returns {string}
 */
export function normalizeSiteRule(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const noScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const wildcard = noScheme.startsWith(WILDCARD_PREFIX);
  const host = normalizeSiteKey(wildcard ? noScheme.slice(WILDCARD_PREFIX.length) : raw);
  if (!host) return '';
  if (!wildcard) return host;
  if (!host.includes('.')) return '';
  return WILDCARD_PREFIX + host;
}

/**
 * True when a hostname is covered by a site rule. Wildcard rules cover the
 * apex domain and every subdomain ("*.example.com" matches example.com,
 * app.example.com, a.b.example.com). Exact rules match only their host.
 * @param {string} rule  site rule key (exact or wildcard)
 * @param {string} host  bare hostname
 */
export function hostMatchesRule(rule, host) {
  if (typeof rule !== 'string' || typeof host !== 'string') return false;
  const h = host.toLowerCase();
  if (isWildcardRule(rule)) {
    const apex = rule.slice(WILDCARD_PREFIX.length);
    return h === apex || h.endsWith(`.${apex}`);
  }
  return h === rule.toLowerCase();
}

/** The apex hostname a rule belongs to ("*.app.example.com" → "app.example.com"). */
export function apexHostOfRule(rule) {
  return isWildcardRule(rule) ? rule.slice(WILDCARD_PREFIX.length) : String(rule ?? '');
}
