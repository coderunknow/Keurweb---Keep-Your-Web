/**
 * Keurweb — Keep Your Web — UI i18n helpers (popup & options only).
 *
 * chrome.i18n is available in every extension page, so UI code just calls
 * t(key, ...subs). Static HTML uses data-i18n / data-i18n-ph / data-i18n-title
 * attributes, which applyI18n() fills once on startup. The English text
 * already present in the markup doubles as a fallback: a node is only
 * replaced when a translation resolves to a non-empty string.
 */

/**
 * Translates a message key, substituting $1…$n in order.
 * Returns '' when the key is missing (callers keep their fallback text).
 * @param {string} key
 * @param {...(string|number)} subs
 */
export function t(key, ...subs) {
  try {
    const message = chrome.i18n.getMessage(key, subs.length > 0 ? subs : undefined);
    return message ?? '';
  } catch {
    return '';
  }
}

/** Fills data-i18n*, data-i18n-ph and data-i18n-title attributes under root. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const text = t(el.dataset.i18n);
    if (text) el.textContent = text;
  }
  for (const el of root.querySelectorAll('[data-i18n-ph]')) {
    const text = t(el.dataset.i18nPh);
    if (text) el.setAttribute('placeholder', text);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const text = t(el.dataset.i18nTitle);
    if (text) el.setAttribute('title', text);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    const text = t(el.dataset.i18nAria);
    if (text) el.setAttribute('aria-label', text);
  }
}

/**
 * Formats an epoch-ms timestamp as a short relative phrase
 * ("just now", "45s ago", "2m ago", …) for the localized UI.
 * @param {number} ts epoch ms
 */
export function relativeTime(ts) {
  if (!ts || ts > Date.now()) return t('relJustNow');
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 45) return t('relSecondsAgo', String(sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return t('relMinutesAgo', String(min));
  const hour = Math.floor(min / 60);
  if (hour < 48) return t('relHoursAgo', String(hour));
  return t('relDaysAgo', String(Math.floor(hour / 24)));
}

/** Locale-aware number formatting for counters. */
export const fmtNum = (n) => new Intl.NumberFormat().format(n);
