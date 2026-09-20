/**
 * Keurweb — Keep Your Web
 * Settings model: validation, normalization, merge and storage persistence.
 * Storage is injectable so the module is unit-testable without a browser.
 */

import {
  DEFAULT_SITE_BEHAVIOR,
  LIMITS,
  defaultSettings,
  normalizeSiteKey,
} from './constants.js';

const KNOWN_BEHAVIOR_KEYS = new Set(Object.keys(DEFAULT_SITE_BEHAVIOR));
const HEARTBEAT_METHODS = new Set(['head', 'get']);
const ACTIVITY_MODES = new Set(['events', 'focus', 'both']);

function clampInt(value, { min, max }, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value, { min, max }, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerces an arbitrary object into a valid behavior object.
 * Unknown keys are dropped; values are range-checked and defaulted.
 * @param {any} raw
 * @returns {object} a fresh, valid behavior object
 */
export function normalizeBehavior(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SITE_BEHAVIOR };
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (!(key in src)) continue;
    const value = src[key];
    switch (key) {
      case 'heartbeat':
      case 'activity':
      case 'antiDiscard':
      case 'autoReload':
      case 'notifyOnReload':
        if (typeof value === 'boolean') out[key] = value;
        break;
      case 'heartbeatIntervalSec':
        out[key] = clampInt(value, LIMITS.heartbeatIntervalSec, out[key]);
        break;
      case 'reloadMaxAttempts':
        out[key] = clampInt(value, LIMITS.reloadMaxAttempts, out[key]);
        break;
      case 'heartbeatMethod':
        if (typeof value === 'string' && HEARTBEAT_METHODS.has(value)) out[key] = value;
        break;
      case 'activityMode':
        if (typeof value === 'string' && ACTIVITY_MODES.has(value)) out[key] = value;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Validates + normalizes a full settings object coming from storage or import.
 * Always returns a complete settings tree; corrupt parts are replaced with
 * defaults rather than throwing, so a bad import can never brick the worker.
 * @param {any} raw
 * @returns {object}
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const settings = defaultSettings();

  if (typeof src.masterEnabled === 'boolean') settings.masterEnabled = src.masterEnabled;

  settings.defaults = normalizeBehavior(src.defaults);

  if (src.sites && typeof src.sites === 'object' && !Array.isArray(src.sites)) {
    for (const [key, value] of Object.entries(src.sites)) {
      const host = normalizeSiteKey(key);
      if (!host) continue;
      settings.sites[host] = normalizeBehavior(value);
      settings.sites[host].enabled = value?.enabled === true;
    }
  }

  if (src.recovery && typeof src.recovery === 'object') {
    settings.recovery = {
      backoffBaseSec: clampNum(
        src.recovery.backoffBaseSec,
        LIMITS.reloadBackoffBaseSec,
        settings.recovery.backoffBaseSec,
      ),
      budgetMin: clampNum(src.recovery.budgetMin, LIMITS.reloadBudgetMin, settings.recovery.budgetMin),
    };
  }

  if (Array.isArray(src.log)) {
    settings.log = src.log
      .filter((e) => e && typeof e === 'object' && typeof e.message === 'string')
      .slice(-LIMITS.maxLogEntries)
      .map((e) => ({
        ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
        level: e.level === 'warn' || e.level === 'error' ? e.level : 'info',
        message: String(e.message).slice(0, 300),
      }));
  }

  return settings;
}

/** No-op storage used in tests when persistence is not under test. */
export const memoryStorage = () => {
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
    async remove(keys) {
      for (const k of keys) map.delete(k);
    },
  };
};

/**
 * Settings repository bound to a chrome.storage-like backend.
 * All reads return fully normalized settings; all writes are validated.
 */
export class SettingsStore {
  /** @param {object} storage chrome.storage.local-like backend */
  constructor(storage) {
    this.storage = storage;
    this.KEY = 'settings';
  }

  /** Loads settings, normalizing whatever is on disk. Never rejects. */
  async load() {
    try {
      const data = await this.storage.get([this.KEY]);
      return normalizeSettings(data?.[this.KEY]);
    } catch {
      return normalizeSettings(undefined);
    }
  }

  /** Persists a full settings tree. Returns the normalized settings saved. */
  async save(settings) {
    const clean = normalizeSettings(settings);
    await this.storage.set({ [this.KEY]: clean });
    return clean;
  }

  /** Applies a partial update via transform, persists and returns the result. */
  async update(transform) {
    const current = await this.load();
    const next = transform(current) ?? current;
    return this.save(next);
  }
}
