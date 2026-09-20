/**
 * Keurweb — Keep Your Web
 * Pure policy helpers shared by the worker and the UI:
 * behavior resolution, reload scheduling and badge state.
 */

import { DEFAULT_SITE_BEHAVIOR, hostMatchesRule, isWildcardRule, normalizeSiteKey } from './constants.js';

/**
 * Finds the site rule (exact or wildcard) that applies to a host.
 * An exact-match rule always wins over wildcards; when several wildcard
 * rules match, the most specific one (longest rule) wins.
 * @param {object} rules settings.sites map
 * @param {string} host bare hostname
 * @returns {string|null} the rule key, or null when no rule matches
 */
export function findSiteRule(rules, host) {
  const key = normalizeSiteKey(host);
  if (!key) return null;
  if (rules?.[key]) return key;
  let best = null;
  for (const rule of Object.keys(rules ?? {})) {
    if (!isWildcardRule(rule)) continue;
    if (hostMatchesRule(rule, key) && (!best || rule.length > best.length)) best = rule;
  }
  return best;
}

/**
 * Resolves the effective behavior for a host:
 * the per-site override (exact rule, else the best wildcard rule) when
 * present, otherwise the global defaults.
 * @param {object} settings normalized settings tree
 * @param {string} host hostname of the site
 * @returns {{behavior: object, source: 'site'|'default', siteEnabled: boolean, rule: string|null, viaWildcard: boolean}}
 */
export function resolveBehavior(settings, host) {
  const rule = findSiteRule(settings?.sites, host);
  const override = rule ? settings.sites[rule] : undefined;
  if (override) {
    return {
      behavior: { ...settings.defaults, ...override },
      source: 'site',
      siteEnabled: override.enabled === true,
      rule,
      viaWildcard: isWildcardRule(rule),
    };
  }
  return { behavior: { ...settings.defaults }, source: 'default', siteEnabled: false, rule: null, viaWildcard: false };
}

/**
 * True when Keurweb should actively protect a tab with this URL:
 * master switch on, site explicitly enabled and http(s) only.
 * @param {object} settings
 * @param {string} url
 */
export function shouldProtect(settings, url) {
  if (!settings.masterEnabled) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const { siteEnabled } = resolveBehavior(settings, parsed.hostname);
  return siteEnabled;
}

/**
 * Computes the next reload delay in seconds with exponential backoff.
 * @param {number} attempt 1-based attempt number
 * @param {number} backoffBaseSec base delay in seconds
 * @returns {number} delay in seconds
 */
export function reloadDelaySec(attempt, backoffBaseSec) {
  const base = Math.max(1, backoffBaseSec || 1);
  const n = Math.max(1, attempt || 1);
  return Math.min(300, base * 2 ** (n - 1));
}

/**
 * Whether another reload attempt is allowed for a tab.
 * @param {{attempts: number, firstAttemptAt: number}} rec recovery record
 * @param {number} maxAttempts
 * @param {number} budgetMin total recovery budget in minutes
 * @param {number} now current epoch ms
 */
export function canAttemptReload(rec, maxAttempts, budgetMin, now) {
  if (!rec) return false;
  if (rec.attempts >= maxAttempts) return false;
  const budgetMs = budgetMin * 60_000;
  return now - rec.firstAttemptAt < budgetMs;
}

/**
 * Badge descriptor for a protection state.
 * The tooltip is an i18n message key (titleKey) so the pure core never
 * hardcodes user-facing prose; the worker resolves it via chrome.i18n.
 */
export function badgeFor(state) {
  switch (state) {
    case 'protected':
      return { text: 'ON', color: '#16a34a', titleKey: 'badgeProtected' };
    case 'recovering':
      return { text: 'RX', color: '#dc2626', titleKey: 'badgeRecovering' };
    case 'global-off':
      return { text: 'OFF', color: '#6b7280', titleKey: 'badgeGlobalOff' };
    case 'site-off':
      return { text: 'OFF', color: '#9ca3af', titleKey: 'badgeSiteOff' };
    default:
      return { text: '', color: '#6b7280', titleKey: 'badgeDefault' };
  }
}

/**
 * Whether the current time falls within the quiet-hours window.
 * @param {number} nowMs  current epoch ms
 * @param {{enabled: boolean, start: string, end: string}} qh  quiet-hours config
 *   start/end are HH:MM in local time; overnight windows (e.g. 22:00→07:00) are valid;
 *   start===end means disabled.
 * @returns {boolean} true when protection is paused
 */
export function isQuietHours(nowMs, qh) {
  if (!qh || !qh.enabled) return false;
  if (qh.start === qh.end) return false; // disabled

  const now = new Date(nowMs);
  const startParts = qh.start.match(/^(\d{2}):(\d{2})$/);
  const endParts = qh.end.match(/^(\d{2}):(\d{2})$/);
  if (!startParts || !endParts) return false;

  const startMs = startParts[1].concat(startParts[2]);
  const endMs = endParts[1].concat(endParts[2]);
  const nowMsOfDay = String(now.getHours()).padStart(2, '0').concat(String(now.getMinutes()).padStart(2, '0'));

  // Overnight window: e.g. 22:00 → 07:00
  if (startMs > endMs) {
    return nowMsOfDay >= startMs || nowMsOfDay < endMs;
  }
  // Same-day window: e.g. 09:00 → 17:00
  return nowMsOfDay >= startMs && nowMsOfDay < endMs;
}
