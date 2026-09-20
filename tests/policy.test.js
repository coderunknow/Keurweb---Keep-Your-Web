import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../src/shared/constants.js';
import { badgeFor, canAttemptReload, reloadDelaySec, resolveBehavior, shouldProtect } from '../src/shared/policy.js';

const withSite = (overrides = {}) => {
  const s = defaultSettings();
  s.sites['app.example.com'] = { enabled: true, ...overrides };
  return s;
};

test('resolveBehavior prefers per-site override over defaults', () => {
  const s = withSite({ heartbeatIntervalSec: 120 });
  const r = resolveBehavior(s, 'app.example.com');
  assert.equal(r.source, 'site');
  assert.equal(r.siteEnabled, true);
  assert.equal(r.behavior.heartbeatIntervalSec, 120);
  assert.equal(r.behavior.heartbeat, true); // inherited from defaults
});

test('resolveBehavior falls back to defaults for unknown sites', () => {
  const r = resolveBehavior(defaultSettings(), 'unknown.example.com');
  assert.equal(r.source, 'default');
  assert.equal(r.siteEnabled, false);
});

test('shouldProtect requires master + enabled site + http(s)', () => {
  const s = withSite();
  assert.equal(shouldProtect(s, 'https://app.example.com/dashboard'), true);
  assert.equal(shouldProtect(s, 'http://app.example.com'), true);

  const masterOff = withSite();
  masterOff.masterEnabled = false;
  assert.equal(shouldProtect(masterOff, 'https://app.example.com'), false, 'master switch gates everything');

  assert.equal(shouldProtect(s, 'https://other.example.com'), false, 'unlisted sites are untouched');
  assert.equal(shouldProtect(s, 'chrome://settings'), false, 'internal pages ignored');
  assert.equal(shouldProtect(s, 'file:///tmp/x'), false, 'file urls ignored');
  assert.equal(shouldProtect(s, 'not a url'), false, 'garbage ignored');
});

test('shouldProtect respects per-site disable', () => {
  const s = withSite({ enabled: false });
  assert.equal(shouldProtect(s, 'https://app.example.com'), false);
});

test('reloadDelaySec grows exponentially and is capped', () => {
  assert.equal(reloadDelaySec(1, 5), 5);
  assert.equal(reloadDelaySec(2, 5), 10);
  assert.equal(reloadDelaySec(3, 5), 20);
  assert.equal(reloadDelaySec(10, 5), 300, 'capped at 5 minutes');
  assert.equal(reloadDelaySec(1, 0), 1, 'degenerate base is safe');
});

test('canAttemptReload enforces attempt cap and time budget', () => {
  const t0 = 1_000_000;
  const rec = { attempts: 0, firstAttemptAt: t0 };
  assert.equal(canAttemptReload(rec, 3, 30, t0), true);
  assert.equal(canAttemptReload({ ...rec, attempts: 3 }, 3, 30, t0 + 1), false, 'attempt cap');
  assert.equal(canAttemptReload({ ...rec, attempts: 1 }, 3, 30, t0 + 31 * 60_000), false, 'budget expired');
  assert.equal(canAttemptReload({ ...rec, attempts: 1 }, 3, 30, t0 + 29 * 60_000), true, 'within budget');
  assert.equal(canAttemptReload(null, 3, 30, t0), false);
});

test('badgeFor maps states to visuals', () => {
  assert.equal(badgeFor('protected').text, 'ON');
  assert.equal(badgeFor('recovering').text, 'RX');
  assert.equal(badgeFor('global-off').text, 'OFF');
  assert.equal(badgeFor('site-off').text, 'OFF');
  assert.equal(badgeFor('unknown').text, '');
});
