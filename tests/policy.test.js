import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../src/shared/constants.js';
import { badgeFor, canAttemptReload, findSiteRule, reloadDelaySec, resolveBehavior, shouldProtect } from '../src/shared/policy.js';

const withSite = (overrides = {}) => {
  const s = defaultSettings();
  s.sites['app.example.com'] = { enabled: true, ...overrides };
  return s;
};

const withWildcard = (rule = '*.example.com', overrides = {}) => {
  const s = defaultSettings();
  s.sites[rule] = { enabled: true, ...overrides };
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

// ------------------------------------------------------- wildcard rules

test('findSiteRule: exact rule wins over wildcard', () => {
  const s = withWildcard();
  s.sites['app.example.com'] = { enabled: false };
  assert.equal(findSiteRule(s.sites, 'app.example.com'), 'app.example.com');
  assert.equal(findSiteRule(s.sites, 'example.com'), '*.example.com');
});

test('findSiteRule: most specific wildcard wins', () => {
  const s = withWildcard();
  s.sites['*.app.example.com'] = { enabled: true };
  assert.equal(findSiteRule(s.sites, 'api.app.example.com'), '*.app.example.com');
  assert.equal(findSiteRule(s.sites, 'web.example.com'), '*.example.com');
  assert.equal(findSiteRule(s.sites, 'other.com'), null);
});

test('wildcard rule protects apex and subdomains, nothing else', () => {
  const s = withWildcard();
  assert.equal(shouldProtect(s, 'https://example.com'), true, 'apex covered');
  assert.equal(shouldProtect(s, 'https://app.example.com/x'), true, 'subdomain covered');
  assert.equal(shouldProtect(s, 'https://a.b.example.com'), true, 'deep subdomain covered');
  assert.equal(shouldProtect(s, 'https://notexample.com'), false, 'suffixed look-alike untouched');
  assert.equal(shouldProtect(s, 'https://example.com.evil.com'), false, 'trailing-label trick untouched');
});

test('wildcard disabled via wildcard rule disables the whole family', () => {
  const s = withWildcard(undefined, { enabled: false });
  assert.equal(shouldProtect(s, 'https://app.example.com'), false);
});

test('exact disabled rule overrides an enabled wildcard for that host only', () => {
  const s = withWildcard();
  s.sites['app.example.com'] = { enabled: false };
  assert.equal(shouldProtect(s, 'https://app.example.com'), false, 'exact override wins');
  assert.equal(shouldProtect(s, 'https://other.example.com'), true, 'siblings stay protected');
});

test('resolveBehavior reports which rule matched and whether it is a wildcard', () => {
  const s = withWildcard();
  const viaWildcard = resolveBehavior(s, 'app.example.com');
  assert.equal(viaWildcard.rule, '*.example.com');
  assert.equal(viaWildcard.viaWildcard, true);
  assert.equal(viaWildcard.source, 'site');

  const viaExact = resolveBehavior(withSite(), 'app.example.com');
  assert.equal(viaExact.rule, 'app.example.com');
  assert.equal(viaExact.viaWildcard, false);

  const none = resolveBehavior(defaultSettings(), 'unknown.example.com');
  assert.equal(none.rule, null);
  assert.equal(none.viaWildcard, false);
  assert.equal(none.siteEnabled, false);
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
