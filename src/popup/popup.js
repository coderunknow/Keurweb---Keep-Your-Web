/**
 * Keurweb — Keep Your Web — popup controller.
 * Talks to the service worker via messages; renders live status.
 */

import { MSG } from '../shared/constants.js';
import { applyI18n, t } from '../ui/i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  master: $('master'),
  unsupported: $('unsupported'),
  sitePanel: $('sitePanel'),
  favicon: $('favicon'),
  host: $('host'),
  statusLine: $('statusLine'),
  statusBadge: $('statusBadge'),
  statusText: $('statusText'),
  toggleBtn: $('toggleBtn'),
  siteSettings: $('siteSettings'),
  interval: $('interval'),
  intervalValue: $('intervalValue'),
  autoReload: $('autoReload'),
  attempts: $('attempts'),
  attemptsWrap: $('attemptsWrap'),
  activity: $('activity'),
  refreshNow: $('refreshNow'),
  advanced: $('advanced'),
  masterNote: $('masterNote'),
  statsLine: $('statsLine'),
  viaLine: $('viaLine'),
  footerText: $('footerText'),
  openOptions: $('openOptions'),
  openOptionsFromUnsupported: $('openOptionsFromUnsupported'),
};

const send = (message) => chrome.runtime.sendMessage(message);

/** The active tab's URL, when supported. @type {string|null} */
let pageUrl = null;
let snapshot = null;
let snapshotAt = 0;

function letterIcon(host) {
  const letter = (host || '?').charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <rect width="32" height="32" rx="8" fill="#4f46e5"/>
    <text x="16" y="21" font-family="system-ui,sans-serif" font-size="16" font-weight="700"
          fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function faviconSrc() {
  try {
    const url = chrome.runtime.getURL('/_favicon/');
    return `${url}?pageUrl=${encodeURIComponent(pageUrl)}&size=32`;
  } catch {
    return letterIcon(snapshot?.host);
  }
}

function setBadge(kind, text) {
  els.statusBadge.className = `kw-badge ${kind}`;
  els.statusText.textContent = text;
}

function fmtCountdown(totalSec) {
  if (totalSec == null) return '';
  const sec = Math.max(0, totalSec);
  if (sec >= 90) return t('durMinutes', String(Math.round(sec / 60)));
  return t('durSeconds', String(sec));
}

function render() {
  if (!pageUrl) {
    els.unsupported.hidden = false;
    els.sitePanel.hidden = true;
    els.footerText.textContent = t('footerUnsupported');
    return;
  }

  els.unsupported.hidden = true;
  els.sitePanel.hidden = false;
  const snap = snapshot ?? {};
  const host = snap.host ?? '';
  els.host.textContent = host;

  // favicon with letter fallback
  els.favicon.onerror = () => {
    els.favicon.onerror = null;
    els.favicon.src = letterIcon(host);
  };
  els.favicon.src = faviconSrc();

  const on = snap.protectedNow === true;
  const recovering = snap.recovering === true;
  els.master.checked = snap.masterEnabled === true;
  els.masterNote.hidden = snap.masterEnabled !== false;

  els.toggleBtn.classList.toggle('on', on);
  els.toggleBtn.textContent = on ? t('keepingAlive') : t('keepAlive');
  els.siteSettings.hidden = !on;
  els.toggleBtn.disabled = snap.masterEnabled === false;

  // Protection via a wildcard rule gets a small "via *.example.com" note.
  const via = on && snap.viaWildcard && snap.rule;
  els.viaLine.hidden = !via;
  if (via) els.viaLine.textContent = t('wildcardVia', snap.rule);

  if (recovering) {
    setBadge('err', t('statusReconnecting'));
    els.statusLine.textContent = t('statusReconnectingLine');
  } else if (!snap.masterEnabled) {
    setBadge('warn', t('statusMasterOff'));
    els.statusLine.textContent = t('statusMasterOffLine');
  } else if (!on) {
    setBadge('muted', t('statusNotProtected'));
    els.statusLine.textContent = t('statusNotProtectedLine');
  } else {
    setBadge('ok', t('statusProtected'));
    const next = nextHeartbeatSeconds();
    els.statusLine.textContent =
      next == null ? t('statusHeartbeatActive') : t('statusNextHeartbeat', fmtCountdown(next));
  }

  // per-site controls reflect effective behavior
  const b = snap.behavior ?? {};
  els.interval.value = b.heartbeatIntervalSec ?? 60;
  els.intervalValue.textContent = t('intervalLabel', els.interval.value);
  els.autoReload.checked = b.autoReload !== false;
  els.attempts.value = String(b.reloadMaxAttempts ?? 3);
  els.attemptsWrap.hidden = !els.autoReload.checked;
  els.activity.checked = b.activity !== false;
}

function nextHeartbeatSeconds() {
  if (!snapshot?.nextHeartbeatInSec) return null;
  const elapsed = (Date.now() - snapshotAt) / 1000;
  return Math.max(0, snapshot.nextHeartbeatInSec - elapsed);
}

async function refresh() {
  try {
    const res = await send({ type: MSG.GET_STATE });
    if (res?.supported && res.snapshot) {
      pageUrl = res.tabUrl ?? `https://${res.snapshot.host}/`;
      snapshot = res.snapshot;
      snapshotAt = Date.now();
    } else {
      pageUrl = null;
      snapshot = null;
    }
  } catch {
    /* worker busy — keep last snapshot */
  }
  render();
}

// ------------------------------------------------------------------ events

els.master.addEventListener('change', async () => {
  await send({ type: MSG.SET_GLOBAL, enabled: els.master.checked });
  refresh();
});

els.toggleBtn.addEventListener('click', async () => {
  els.toggleBtn.disabled = true;
  try {
    await send({ type: MSG.TOGGLE_SITE });
  } finally {
    els.toggleBtn.disabled = false;
    refresh();
  }
});

els.interval.addEventListener('input', () => {
  els.intervalValue.textContent = t('intervalLabel', els.interval.value);
});

els.interval.addEventListener('change', () => {
  void send({ type: MSG.SET_SITE_BEHAVIOR, host: snapshot.host, patch: { heartbeatIntervalSec: Number(els.interval.value) } });
});

els.autoReload.addEventListener('change', () => {
  void send({ type: MSG.SET_SITE_BEHAVIOR, host: snapshot.host, patch: { autoReload: els.autoReload.checked } });
  els.attemptsWrap.hidden = !els.autoReload.checked;
});

els.attempts.addEventListener('change', () => {
  void send({ type: MSG.SET_SITE_BEHAVIOR, host: snapshot.host, patch: { reloadMaxAttempts: Number(els.attempts.value) } });
});

els.activity.addEventListener('change', () => {
  void send({ type: MSG.SET_SITE_BEHAVIOR, host: snapshot.host, patch: { activity: els.activity.checked } });
});

els.refreshNow.addEventListener('click', async () => {
  els.refreshNow.innerHTML = '<span class="kw-spinner"></span>';
  try {
    await send({ type: MSG.KEEPALIVE_NOW });
    await new Promise((r) => setTimeout(r, 350));
  } finally {
    els.refreshNow.textContent = t('refreshNow');
    refresh();
  }
});

applyI18n();
document.title = t('popupTitle');

const openOptionsAt = (query) => {
  const url = chrome.runtime.getURL(`options/options.html${query}`);
  chrome.tabs.create({ url });
};
// Deep-link the options dashboard to the matched rule (wildcard or exact)
// so the right site card is pre-selected.
els.advanced.addEventListener('click', () =>
  openOptionsAt(snapshot?.host ? `?site=${encodeURIComponent(snapshot.rule ?? snapshot.host)}` : ''),
);
els.openOptions.addEventListener('click', () => openOptionsAt(''));
els.openOptionsFromUnsupported.addEventListener('click', () => openOptionsAt(''));

// live countdown refresh
setInterval(() => {
  if (snapshot?.protectedNow && !snapshot.recovering) render();
}, 1000);
setInterval(refresh, 10000);

refresh();
