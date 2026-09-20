/**
 * Keurweb — Keep Your Web — options page controller.
 * Reads/writes settings directly through SettingsStore and notifies the
 * service worker (SETTINGS_CHANGED) so open tabs re-evaluate immediately.
 */

import {
  ALL_BEHAVIOR_KEYS,
  LIMITS,
  MSG,
  apexHostOfRule,
  defaultSettings,
  isWildcardRule,
  normalizeSiteRule,
} from '../shared/constants.js';
import { SettingsStore } from '../shared/settings.js';

const store = new SettingsStore(chrome.storage.local);
const $ = (id) => document.getElementById(id);

const els = {
  master: $('master'),
  siteCount: $('siteCount'),
  addForm: $('addForm'),
  addInput: $('addInput'),
  addError: $('addError'),
  siteList: $('siteList'),
  sitesEmpty: $('sitesEmpty'),
  logList: $('logList'),
  logEmpty: $('logEmpty'),
  clearLogBtn: $('clearLogBtn'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  resetBtn: $('resetBtn'),
  toast: $('toast'),
  version: $('version'),
};

/** @type {object} last loaded settings tree */
let settings = defaultSettings();
const expandedSites = new Set();

// ------------------------------------------------------------------ helpers

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

async function persist(mutate) {
  settings = await store.update(mutate);
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_CHANGED }).catch(() => {});
}

const saveDefaults = () =>
  persist((s) => {
    s.defaults = settings.defaults;
    return s;
  });

const saveRecovery = () =>
  persist((s) => {
    s.recovery = settings.recovery;
    return s;
  });

function letterIcon(rule) {
  const letter = (apexHostOfRule(rule) || '?').charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#4f46e5"/><text x="16" y="21" font-family="system-ui,sans-serif" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// --------------------------------------------------------------- navigation

const VIEWS = ['general', 'sites', 'log', 'about'];

function show(view) {
  if (!VIEWS.includes(view)) view = 'general';
  for (const v of VIEWS) {
    $(`view-${v}`).hidden = v !== view;
  }
  for (const btn of document.querySelectorAll('.kw-nav-btn')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  history.replaceState(null, '', `#${view}`);
  if (view === 'log') refreshLog();
}

for (const btn of document.querySelectorAll('.kw-nav-btn')) {
  btn.addEventListener('click', () => show(btn.dataset.view));
}

// ------------------------------------------------------------ general forms

/** Pushes current settings into the General-form controls (no listeners). */
function syncBehaviorControls() {
  for (const input of document.querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    if (input.type === 'checkbox') input.checked = settings.defaults[key] !== false;
    else input.value = String(settings.defaults[key] ?? '');
    reflectDependent(key);
  }
  for (const [id, key, format] of [
    ['g-backoffBaseSec', 'backoffBaseSec', (v) => `${v}s`],
    ['g-budgetMin', 'budgetMin', (v) => `${v} min`],
  ]) {
    $(id).value = String(settings.recovery[key]);
    $(`${id}-val`).textContent = format(settings.recovery[key]);
  }
}

/** One-time wiring of the General form listeners. */
function bindBehaviorControls() {
  for (const input of document.querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    input.addEventListener('change', async () => {
      const value =
        input.type === 'checkbox' ? input.checked : input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value;
      settings.defaults = { ...settings.defaults, [key]: value };
      await saveDefaults();
      reflectDependent(key);
      toast('Saved');
    });
    if (input.type === 'range') {
      input.addEventListener('input', () => {
        $(`g-${key}-val`).textContent = input.value;
      });
    }
  }

  for (const [id, key] of [
    ['g-backoffBaseSec', 'backoffBaseSec'],
    ['g-budgetMin', 'budgetMin'],
  ]) {
    const input = $(id);
    const format = (v) => (key === 'budgetMin' ? `${v} min` : `${v}s`);
    input.addEventListener('change', async () => {
      const limits = LIMITS[id === 'g-budgetMin' ? 'reloadBudgetMin' : 'reloadBackoffBaseSec'];
      const n = Math.min(limits.max, Math.max(limits.min, Number(input.value) || limits.min));
      input.value = String(n);
      settings.recovery = { ...settings.recovery, [key]: n };
      $(`${id}-val`).textContent = format(n);
      await saveRecovery();
      toast('Saved');
    });
  }
}

/** Enables/disables dependent controls (e.g. interval when heartbeat off). */
function reflectDependent(key) {
  const map = {
    heartbeat: ['g-heartbeatIntervalSec', 'g-heartbeatMethod'],
    activity: ['g-activityMode'],
    autoReload: ['g-reloadMaxAttempts', 'g-notifyOnReload'],
  };
  for (const dep of map[key] ?? []) {
    const control = $(dep);
    if (control) control.disabled = $(`g-${key}`)?.checked === false;
  }
  if (key === 'heartbeatIntervalSec') {
    $('g-heartbeatIntervalSec-val').textContent = $('g-heartbeatIntervalSec').value;
  }
}

// -------------------------------------------------------------------- sites

function behaviorRow(label, hint, controlHtml) {
  return `<div class="kw-row">
    <span><span class="kw-label">${label}</span>${hint ? `<p class="kw-hint">${hint}</p>` : ''}</span>
    ${controlHtml}
  </div>`;
}

function switchHtml(checked, dataKey) {
  return `<span class="kw-switch"><input type="checkbox" ${checked ? 'checked' : ''} data-site-key="${dataKey}"><span class="kw-track"></span><span class="kw-knob"></span></span>`;
}

/**
 * Builds the expandable per-site control panel.
 * The template only interpolates validated numbers and static, localized
 * strings — rule keys are attached via setAttribute, never as HTML.
 */
function buildSiteDetail(rule) {
  const site = settings.sites[rule] ?? {};
  const b = { ...settings.defaults, ...site };
  const usingDefaults = ALL_BEHAVIOR_KEYS.every((k) => !(k in site));
  const interval = b.heartbeatIntervalSec ?? 60;
  const rows = [
    behaviorRow('Session heartbeat', 'Warm-up ping to keep the session alive', switchHtml(b.heartbeat !== false, 'heartbeat')),
    behaviorRow('Heartbeat interval', `<span data-hint="heartbeatIntervalSec">Every ${interval}s</span>`, `<input type="range" min="${LIMITS.heartbeatIntervalSec.min}" max="1800" step="15" value="${interval}" data-site-key="heartbeatIntervalSec">`),
    behaviorRow('Anti-idle activity', 'Simulated user activity', switchHtml(b.activity !== false, 'activity')),
    behaviorRow('Anti-discard sweep', 'Discourages tab freezing', switchHtml(b.antiDiscard !== false, 'antiDiscard')),
    behaviorRow('Auto-reconnect', 'Reload the tab when it dies', switchHtml(b.autoReload !== false, 'autoReload')),
    behaviorRow('Notify when reconnecting', '', switchHtml(b.notifyOnReload === true, 'notifyOnReload')),
  ].join('');
  const wrap = document.createElement('div');
  wrap.className = 'kw-site-detail';
  wrap.dataset.detail = rule;
  wrap.innerHTML = `
    ${usingDefaults ? '<p class="kw-site-using-default">Using global defaults — customize below.</p>' : ''}
    ${rows}
    <div class="kw-btn-row">
      <button class="btn-ghost" data-reset-site>↺ Reset to defaults</button>
    </div>`;
  return wrap;
}

function renderSites() {
  const rules = Object.keys(settings.sites).sort();
  els.siteCount.textContent = rules.length ? String(rules.length) : '';
  els.sitesEmpty.hidden = rules.length > 0;
  els.siteList.textContent = '';

  for (const rule of rules) {
    const site = settings.sites[rule];
    const enabled = site?.enabled === true;
    const wildcard = isWildcardRule(rule);

    const card = document.createElement('div');
    card.className = 'kw-card kw-site-item';
    card.dataset.hostCard = rule;

    const head = document.createElement('div');
    head.className = 'kw-site-item-head';

    const icon = document.createElement('img');
    icon.className = 'kw-favicon';
    icon.alt = '';
    icon.width = 26;
    icon.height = 26;
    icon.onerror = () => {
      icon.onerror = null;
      icon.src = letterIcon(rule);
    };
    icon.src = `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(`https://${apexHostOfRule(rule)}/`)}&size=32`;

    const name = document.createElement('span');
    name.className = 'kw-site-host';
    name.textContent = rule; // textContent — never inject rule keys as HTML

    if (wildcard) {
      const chip = document.createElement('span');
      chip.className = 'kw-chip';
      chip.textContent = 'Subdomains';
      head.append(icon, name, chip);
    } else {
      head.append(icon, name);
    }

    const customize = document.createElement('button');
    customize.className = 'btn-ghost';
    customize.textContent = expandedSites.has(rule) ? 'Hide options ▲' : 'Customize ▼';
    customize.addEventListener('click', () => {
      expandedSites.has(rule) ? expandedSites.delete(rule) : expandedSites.add(rule);
      renderSites();
    });

    const label = document.createElement('label');
    label.className = 'kw-switch';
    label.title = enabled ? 'Protection on' : 'Protection off';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.setAttribute('aria-label', `Protect ${rule}`);
    input.addEventListener('change', async () => {
      await persist((s) => {
        if (!s.sites[rule]) s.sites[rule] = {};
        s.sites[rule].enabled = input.checked;
        return s;
      });
      toast(input.checked ? `Protecting ${rule}` : `${rule} paused`);
      renderSites();
    });
    const track = document.createElement('span');
    track.className = 'kw-track';
    const knob = document.createElement('span');
    knob.className = 'kw-knob';
    label.append(input, track, knob);

    const remove = document.createElement('button');
    remove.className = 'btn-ghost btn-danger';
    remove.textContent = 'Remove';
    remove.title = `Stop managing ${rule}`;
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${rule} from Keurweb?`)) return;
      await persist((s) => {
        delete s.sites[rule];
        return s;
      });
      toast(`${rule} removed`);
      renderSites();
    });

    head.append(customize, label, remove);
    card.append(head);
    if (expandedSites.has(rule)) {
      card.append(buildSiteDetail(rule));
    }
    els.siteList.append(card);
  }

  bindSiteDetailEvents();
}

function bindSiteDetailEvents() {
  for (const input of els.siteList.querySelectorAll('[data-site-key]')) {
    const rule = input.closest('[data-detail]')?.dataset.detail;
    const key = input.dataset.siteKey;
    if (!rule || !key) continue;
    input.addEventListener('change', async () => {
      const value = input.type === 'checkbox' ? input.checked : Number(input.value);
      await persist((s) => {
        if (!s.sites[rule]) s.sites[rule] = { enabled: true };
        s.sites[rule][key] = value;
        return s;
      });
      if (key === 'heartbeatIntervalSec') {
        const hint = input.closest('.kw-row')?.querySelector('[data-hint]');
        if (hint) hint.textContent = `Every ${value}s`;
      }
      toast('Saved');
    });
  }

  for (const btn of els.siteList.querySelectorAll('[data-reset-site]')) {
    const rule = btn.closest('[data-detail]')?.dataset.detail;
    if (!rule) continue;
    btn.addEventListener('click', async () => {
      await persist((s) => {
        const enabled = s.sites[rule]?.enabled === true;
        s.sites[rule] = { ...(enabled ? { enabled: true } : {}) };
        return s;
      });
      toast(`${rule} reset to defaults`);
      renderSites();
    });
  }
}

els.addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const rule = normalizeSiteRule(els.addInput.value);
  if (!rule) {
    els.addError.textContent = 'That doesn’t look like a website address. Try example.com or *.example.com';
    els.addError.classList.add('error');
    return;
  }
  if (settings.sites[rule]) {
    els.addError.textContent = `${rule} is already in your list.`;
    els.addError.classList.add('error');
    expandedSites.add(rule);
    renderSites();
    return;
  }
  els.addError.textContent = '';
  els.addError.classList.remove('error');
  await persist((s) => {
    s.sites[rule] = { enabled: true };
    return s;
  });
  els.addInput.value = '';
  expandedSites.add(rule);
  toast(`Now protecting ${rule}`);
  renderSites();
});

// ---------------------------------------------------------------------- log

const LEVEL_ICON = { info: '●', warn: '▲', error: '✖' };

async function refreshLog() {
  let log = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_LOG });
    log = Array.isArray(res?.log) ? res.log : [];
  } catch {
    /* worker unavailable */
  }
  els.logList.textContent = '';
  els.logEmpty.hidden = log.length > 0;
  for (const entry of [...log].reverse()) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(entry.ts).toLocaleString();
    const lv = document.createElement('span');
    lv.className = `kw-lv ${entry.level}`;
    lv.title = entry.level;
    lv.textContent = LEVEL_ICON[entry.level] ?? '●';
    const msg = document.createElement('span');
    msg.textContent = entry.message;
    li.append(time, lv, msg);
    els.logList.append(li);
  }
}

els.clearLogBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.LOG_CLEARED }).catch(() => {});
  refreshLog();
});

// --------------------------------------------------------------------- data

els.exportBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: MSG.EXPORT_SETTINGS }).catch(() => null);
  if (!res?.payload) return toast('Export failed');
  const blob = new Blob([res.payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `keurweb-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Settings exported');
});

els.importBtn.addEventListener('click', () => els.importFile.click());

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files?.[0];
  if (!file) return;
  const payload = await file.text();
  const res = await chrome.runtime.sendMessage({ type: MSG.IMPORT_SETTINGS, payload }).catch(() => null);
  if (res?.error) {
    toast(`Import failed: ${res.error}`);
  } else {
    toast('Settings imported');
    await hydrate();
  }
  els.importFile.value = '';
});

els.resetBtn.addEventListener('click', async () => {
  if (!confirm('Reset ALL Keurweb settings and sites? This cannot be undone.')) return;
  await chrome.runtime.sendMessage({ type: MSG.RESET_SETTINGS }).catch(() => {});
  toast('Everything reset');
  await hydrate();
});

// ------------------------------------------------------------------ master

els.master.addEventListener('change', async () => {
  await persist((s) => {
    s.masterEnabled = els.master.checked;
    return s;
  });
  toast(els.master.checked ? 'Keurweb is on' : 'Keurweb paused everywhere');
});

// -------------------------------------------------------------------- boot

async function hydrate() {
  settings = await store.load();
  els.master.checked = settings.masterEnabled;
  bindBehaviorControls();
  renderSites();
}

els.version.textContent = chrome.runtime.getManifest().version;

const params = new URLSearchParams(location.search);
const preselect = params.get('site');
const hashView = location.hash.replace('#', '');

hydrate().then(() => {
  show(VIEWS.includes(hashView) ? hashView : 'general');
  if (preselect) {
    const rule = normalizeSiteRule(preselect);
    if (rule && settings.sites[rule]) {
      expandedSites.add(rule);
      show('sites');
      renderSites();
      $(`[data-host-card="${CSS.escape(rule)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (rule) {
      els.addInput.value = rule;
      show('sites');
      els.addInput.focus();
    }
  }
});
