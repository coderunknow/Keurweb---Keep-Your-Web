/**
 * Keurweb — Keep Your Web
 * KeepAliveEngine: the pure scheduling/decision core of the extension.
 *
 * The engine holds no browser APIs. It is driven entirely by events
 * (ticks, page activity, disconnect reports) and returns a list of intents
 * (actions the worker must perform). This keeps the heart of the product
 * deterministic and unit-testable.
 */

import { LIMITS } from './constants.js';
import { canAttemptReload, reloadDelaySec, resolveBehavior, shouldProtect } from './policy.js';

/** @typedef {'ping'|'simulate'|'sweep'|'reload'|'notify'|'badge'|'inject'} IntentKind */

const NOW = () => Date.now();

/**
 * @typedef {object} Intent
 * @property {IntentKind} kind  what the worker should do
 * @property {number} [tabId]   target tab
 * @property {string} [host]    target host
 * @property {string} [url]     target url
 * @property {number} [delayMs] for 'reload' intents: delay before reloading
 * @property {string} [message] for 'notify' intents
 * @property {string} [state]   for 'badge' intents
 */

/**
 * @typedef {object} TrackedTab
 * @property {number} tabId
 * @property {string} host
 * @property {string} url
 * @property {number} addedAt
 * @property {number} lastHeartbeatAt
 * @property {number} lastSimAt
 * @property {number} lastSweepAt
 * @property {number} lastSeenAt     last client activity report
 * @property {number} lastInjectedAt when behavior was last pushed to the page
 * @property {{attempts: number, firstAttemptAt: number, lastAttemptAt: number}|null} recovery
 */

export class KeepAliveEngine {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] clock injection for tests
   */
  constructor(options = {}) {
    this.now = options.now ?? NOW;
    /** @type {Map<number, TrackedTab>} */
    this.tabs = new Map();
    /** @type {Array<{ts: number, level: string, message: string}>} */
    this.log = [];
    /** tabId → epoch ms list of reload attempts (per-tab budget evidence). */
    this.reloadAttemptLog = new Map();
    /** tabId → epoch ms when recovery was surrendered (reload-storm guard). */
    this.surrendered = new Map();
  }

  /** Cooldown before a surrendered tab may start a new recovery episode. */
  static SURRENDER_COOLDOWN_MS = 5 * 60_000;

  // ---------------------------------------------------------------- logging

  /** @returns {Array<{ts:number, level:string, message:string}>} newest last */
  getLog() {
    return this.log.slice(-LIMITS.maxLogEntries);
  }

  /**
   * Records a structured log entry. Entries store an i18n message key plus
   * substitutions (the UI renders them via chrome.i18n); no UI code paths
   * depend on pre-formatted prose, so the pure core stays translation-free.
   * @param {'info'|'warn'|'error'} level
   * @param {string} key chrome.i18n message key
   * @param {Array<string|number>} [params] $1…$n substitutions
   */
  push(level, key, params = []) {
    this.log.push({ ts: this.now(), level, key, params: params.map(String) });
    if (this.log.length > LIMITS.maxLogEntries) {
      this.log.splice(0, this.log.length - LIMITS.maxLogEntries);
    }
  }

  clearLog() {
    this.log = [];
  }

  /**
   * @private
   * Mutates settings.stats[rule] in place; the worker persists the tree
   * after the call. Pure: no I/O, no browser APIs.
   */
  bumpStat(settings, rule, patch) {
    if (!rule || !settings?.stats || typeof settings.stats !== 'object') return;
    const cur =
      settings.stats[rule] ??
      (settings.stats[rule] = {
        heartbeats: 0,
        recoveries: 0,
        lastHeartbeatAt: 0,
        lastDisconnectAt: 0,
        lastRecoverAt: 0,
      });
    if (patch.heartbeats) cur.heartbeats += patch.heartbeats;
    if (patch.recoveries) cur.recoveries += patch.recoveries;
    for (const field of ['lastHeartbeatAt', 'lastDisconnectAt', 'lastRecoverAt']) {
      if (patch[field]) cur[field] = patch[field];
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Starts tracking a tab. Returns intents to run immediately
   * (badge update + behavior injection when the site is protected).
   * @param {number} tabId
   * @param {string} url
   * @param {object} settings normalized settings
   * @returns {Intent[]}
   */
  trackTab(tabId, url, settings) {
    let host = '';
    let protocol = '';
    try {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
      protocol = parsed.protocol;
    } catch {
      return [];
    }
    if (!host || (protocol !== 'http:' && protocol !== 'https:')) return [];

    const existing = this.tabs.get(tabId);
    const t = this.now();
    if (existing && existing.host === host && existing.url === url) {
      return []; // revalidation of a known tab — nothing to do
    }

    this.tabs.set(tabId, {
      tabId,
      host,
      url,
      addedAt: existing?.addedAt ?? t,
      lastHeartbeatAt: 0,
      lastSimAt: 0,
      lastSweepAt: existing?.lastSweepAt ?? 0,
      lastSeenAt: t,
      lastInjectedAt: 0,
      recovery: null,
    });
    this.reloadAttemptLog.delete(tabId);

    if (!shouldProtect(settings, url)) {
      return [{ kind: 'badge', tabId, state: settings.masterEnabled ? 'site-off' : 'global-off' }];
    }
    this.push('info', 'logTracking', [host, tabId]);
    return [
      { kind: 'badge', tabId, state: 'protected' },
      { kind: 'inject', tabId, host, url },
    ];
  }

  /** Stops tracking a tab. @returns {Intent[]} */
  untrackTab(tabId) {
    const rec = this.tabs.get(tabId);
    if (rec) this.push('info', 'logUntracked', [rec.host, tabId]);
    this.tabs.delete(tabId);
    this.reloadAttemptLog.delete(tabId);
    return [];
  }

  /** Tabs currently tracked. @returns {TrackedTab[]} */
  getTrackedTabs() {
    return [...this.tabs.values()];
  }

  getTab(tabId) {
    return this.tabs.get(tabId) ?? null;
  }

  // ----------------------------------------------------------- client pings

  /**
   * Records a keep-alive ping from the content script (client is alive).
   * @returns {Intent[]}
   */
  noteClientPing(tabId) {
    const rec = this.tabs.get(tabId);
    if (rec) rec.lastSeenAt = this.now();
    return [];
  }

  // ------------------------------------------------------------- main tick

  /**
   * Periodic tick. Evaluates every tracked tab against its effective
   * behavior and returns the intents the worker should execute.
   * @param {object} settings normalized settings
   * @returns {Intent[]}
   */
  tick(settings) {
    const intents = [];
    if (!settings.masterEnabled) return intents;
    const t = this.now();

    for (const tab of this.tabs.values()) {
      const url = tab.url;
      if (!shouldProtect(settings, url)) continue;
      const { behavior, rule } = resolveBehavior(settings, tab.host);

      // 1. Server heartbeat — direct warm-up ping from the worker.
      if (behavior.heartbeat) {
        const intervalMs = behavior.heartbeatIntervalSec * 1000;
        if (t - tab.lastHeartbeatAt >= intervalMs) {
          tab.lastHeartbeatAt = t;
          this.bumpStat(settings, rule, { heartbeats: 1, lastHeartbeatAt: t });
          intents.push({
            kind: 'ping',
            tabId: tab.tabId,
            host: tab.host,
            url,
            method: behavior.heartbeatMethod.toUpperCase(),
          });
        }
      }

      // 2. Client activity simulation — only if the page has gone quiet.
      if (behavior.activity) {
        const quietMs = LIMITS.activityIntervalSec.min * 1000;
        if (t - tab.lastSimAt >= quietMs && t - tab.lastSeenAt >= quietMs) {
          tab.lastSimAt = t;
          intents.push({ kind: 'simulate', tabId: tab.tabId, host: tab.host });
        }
      }

      // 3. Anti-discard sweep — periodically marks the tab as recently used.
      if (behavior.antiDiscard) {
        const sweepEveryMs = 4 * 60_000;
        if (t - tab.lastSweepAt >= sweepEveryMs) {
          tab.lastSweepAt = t;
          intents.push({ kind: 'sweep', tabId: tab.tabId, host: tab.host });
        }
      }

      // 4. Recovery already in flight for this tab? Schedule next attempt.
      if (tab.recovery) {
        this.scheduleNextRecovery(tab, settings, t, intents);
      }
    }

    return intents;
  }

  // ------------------------------------------------------------- recovery

  /**
   * Records a disconnect/failure for a tab and decides whether to reload.
   * @param {number} tabId
   * @param {object} settings
   * @param {object} [detail] { kind, status }
   * @returns {Intent[]}
   */
  reportDisconnect(tabId, settings, detail = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab || !shouldProtect(settings, tab.url)) return [];
    const { behavior } = resolveBehavior(settings, tab.host);
    if (!behavior.autoReload) return [];

    const t = this.now();

    // Reload-storm guard: after surrendering, stay quiet for a cooldown so a
    // prolonged outage cannot cycle "give up → error page → reload" forever.
    const surrenderedAt = this.surrendered.get(tabId);
    if (surrenderedAt != null) {
      if (t - surrenderedAt < KeepAliveEngine.SURRENDER_COOLDOWN_MS) return [];
      this.surrendered.delete(tabId); // cooldown elapsed — try a fresh episode
      tab.recovery = null;
    }

    if (!tab.recovery) {
      tab.recovery = { attempts: 0, firstAttemptAt: t, lastAttemptAt: 0 };
    }

    if (!canAttemptReload(tab.recovery, behavior.reloadMaxAttempts, settings.recovery.budgetMin, t)) {
      this.push('error', 'logSurrendered', [tab.host, tabId]);
      tab.recovery = null;
      this.surrendered.set(tabId, t);
      return [{ kind: 'badge', tabId, state: 'site-off' }];
    }

    tab.recovery.attempts += 1;
    tab.recovery.lastAttemptAt = t;

    const { rule } = resolveBehavior(settings, tab.host);
    this.bumpStat(settings, rule, { lastDisconnectAt: t });

    const delays = this.reloadAttemptLog.get(tabId) ?? [];
    delays.push(t);
    this.reloadAttemptLog.set(tabId, delays);

    const delaySec = reloadDelaySec(tab.recovery.attempts, settings.recovery.backoffBaseSec);
    const reason = detail.status ? `${detail.kind ?? 'unknown'} ${detail.status}` : detail.kind ?? 'unknown';
    this.push('warn', 'logReloadScheduled', [tab.host, reason, delaySec, tab.recovery.attempts, behavior.reloadMaxAttempts]);

    const intents = [
      { kind: 'reload', tabId, host: tab.host, url: tab.url, delayMs: delaySec * 1000 },
      { kind: 'badge', tabId, state: 'recovering' },
    ];
    if (behavior.notifyOnReload && tab.recovery.attempts === 1) {
      intents.push({ kind: 'notify', titleKey: 'notifyTitle', messageKey: 'notifyReconnect', messageParams: [tab.host] });
    }
    return intents;
  }

  /**
   * If a recovery attempt is due, emits the reload intent.
   * @private
   */
  scheduleNextRecovery(tab, settings, t, intents) {
    if (!tab.recovery) return;
    const { behavior } = resolveBehavior(settings, tab.host);
    const sinceLast = t - tab.recovery.lastAttemptAt;
    const delayMs = reloadDelaySec(tab.recovery.attempts, settings.recovery.backoffBaseSec) * 1000;
    if (sinceLast >= delayMs) {
      intents.push({ kind: 'reload', tabId: tab.tabId, host: tab.host, url: tab.url, delayMs: 0 });
    }
  }

  /**
   * Called after a tab successfully finished loading again.
   * @param {number} tabId
   * @param {object} [settings] normalized settings — when given, the
   *   site's recovery counters are updated.
   * @returns {Intent[]}
   */
  noteRecovered(tabId, settings) {
    const tab = this.tabs.get(tabId);
    if (tab?.recovery) {
      this.push('info', 'logRecovered', [tab.host, tab.recovery.attempts]);
      if (settings) {
        const { rule } = resolveBehavior(settings, tab.host);
        this.bumpStat(settings, rule, { recoveries: 1, lastRecoverAt: this.now() });
      }
      tab.recovery = null;
    }
    return [{ kind: 'badge', tabId, state: 'protected' }];
  }

  /**
   * Manual "ping now" from the popup. Works for tracked tabs and for
   * protected-but-untracked URLs (e.g. right after a worker restart);
   * counted toward the site's heartbeat stats.
   * @param {number} tabId
   * @param {object} settings normalized settings
   * @param {string} [url] the popup's active tab URL (fallback target)
   * @returns {Intent[]}
   */
  pingNow(tabId, settings, url) {
    const tab = this.tabs.get(tabId);
    let host = '';
    let targetUrl = '';
    // The caller's URL (the popup's active tab) is authoritative; fall back
    // to the tracked record only when no URL was provided.
    if (url && shouldProtect(settings, url)) {
      try {
        host = new URL(url).hostname.toLowerCase();
        targetUrl = url;
      } catch {
        host = '';
      }
    }
    if (!targetUrl && tab && shouldProtect(settings, tab.url)) {
      host = tab.host;
      targetUrl = tab.url;
    }
    if (!targetUrl) return [];
    const t = this.now();
    if (tab && tab.url === targetUrl) tab.lastHeartbeatAt = t;
    const { rule, behavior } = resolveBehavior(settings, host);
    this.bumpStat(settings, rule, { heartbeats: 1, lastHeartbeatAt: t });
    return [{ kind: 'ping', tabId, host, url: targetUrl, method: behavior.heartbeatMethod.toUpperCase() }];
  }

  // -------------------------------------------------------------- queries

  /**
   * Snapshot for the popup: per-site status and next heartbeat countdown.
   * @param {object} settings
   * @param {string} url the popup's active tab URL
   */
  describeSite(settings, url) {
    const { behavior, source, siteEnabled, rule, viaWildcard } = resolveBehavior(settings, url);
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      /* leave empty */
    }
    const protectedNow = shouldProtect(settings, url);
    const tab = [...this.tabs.values()].find((tb) => tb.host === host) ?? null;
    const t = this.now();
    return {
      host,
      protectedNow,
      masterEnabled: settings.masterEnabled,
      source,
      siteEnabled,
      rule,
      viaWildcard,
      behavior,
      stats: rule ? settings.stats?.[rule] ?? null : null,
      tracked: Boolean(tab),
      recovering: Boolean(tab?.recovery),
      secondsSinceHeartbeat: tab && tab.lastHeartbeatAt ? Math.round((t - tab.lastHeartbeatAt) / 1000) : null,
      nextHeartbeatInSec:
        tab && behavior.heartbeat
          ? Math.max(0, Math.round((tab.lastHeartbeatAt + behavior.heartbeatIntervalSec * 1000 - t) / 1000))
          : null,
      log: this.getLog().slice(-50).reverse(),
    };
  }

  /** Internal consistency helper used by tests. */
  _tabCount() {
    return this.tabs.size;
  }
}
