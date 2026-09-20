import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_VERSION,
  DEFAULT_SITE_BEHAVIOR,
  LIMITS,
  MSG,
  normalizeSiteKey,
  normalizeSiteRule,
  isWildcardRule,
  hostMatchesRule,
  apexHostOfRule,
  defaultSettings,
  ALL_BEHAVIOR_KEYS,
} from '../src/shared/constants.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'src/manifest.json'), 'utf8'));
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

test('normalizeSiteKey trims, lowercases and strips scheme/path', () => {
  assert.equal(normalizeSiteKey('https://App.Example.com/path?q=1'), 'app.example.com');
  assert.equal(normalizeSiteKey('  EXAMPLE.com  '), 'example.com');
  assert.equal(normalizeSiteKey('http://localhost:3000/x'), 'localhost');
  assert.equal(normalizeSiteKey('//cdn.example.com'), 'cdn.example.com', 'protocol-relative input is accepted');
});

test('normalizeSiteKey rejects garbage', () => {
  assert.equal(normalizeSiteKey(''), '');
  assert.equal(normalizeSiteKey(null), '');
  assert.equal(normalizeSiteKey('   '), '');
  assert.equal(normalizeSiteKey('http://'), '');
  assert.equal(normalizeSiteKey('*example.com'), '', 'stray asterisks are not hostnames');
  assert.equal(normalizeSiteKey('*.example.com'), '', 'wildcards are rules, not exact keys');
});

test('normalizeSiteRule accepts exact hosts and wildcard rules', () => {
  assert.equal(normalizeSiteRule('example.com'), 'example.com');
  assert.equal(normalizeSiteRule('https://App.Example.com/x'), 'app.example.com');
  assert.equal(normalizeSiteRule('*.example.com'), '*.example.com');
  assert.equal(normalizeSiteRule('  *.Example.com  '), '*.example.com');
  assert.equal(normalizeSiteRule('https://*.example.com/x'), '*.example.com', 'scheme before wildcard is accepted');
});

test('normalizeSiteRule rejects over-broad and malformed wildcards', () => {
  assert.equal(normalizeSiteRule('*.com'), '', 'no single-label wildcards');
  assert.equal(normalizeSiteRule('*example.com'), '', 'missing dot after asterisk');
  assert.equal(normalizeSiteRule('*.exa**mple.com'), '', 'second asterisk rejected');
  assert.equal(normalizeSiteRule('*'), '');
  assert.equal(normalizeSiteRule(''), '');
  assert.equal(normalizeSiteRule('not a url!!'), '');
});

test('isWildcardRule / apexHostOfRule describe rule shape', () => {
  assert.equal(isWildcardRule('*.example.com'), true);
  assert.equal(isWildcardRule('example.com'), false);
  assert.equal(isWildcardRule(''), false);
  assert.equal(apexHostOfRule('*.app.example.com'), 'app.example.com');
  assert.equal(apexHostOfRule('example.com'), 'example.com');
});

test('hostMatchesRule: exact rules are strict, wildcards cover apex + subdomains', () => {
  assert.equal(hostMatchesRule('example.com', 'example.com'), true);
  assert.equal(hostMatchesRule('example.com', 'app.example.com'), false, 'exact rules do not cover subdomains');
  assert.equal(hostMatchesRule('*.example.com', 'example.com'), true, 'wildcard covers the apex');
  assert.equal(hostMatchesRule('*.example.com', 'app.example.com'), true);
  assert.equal(hostMatchesRule('*.example.com', 'a.b.example.com'), true, 'deep subdomains covered');
  assert.equal(hostMatchesRule('*.example.com', 'notexample.com'), false, 'suffixed look-alikes rejected');
  assert.equal(hostMatchesRule('*.example.com', 'example.com.evil.com'), false);
});

test('defaultSettings is complete and fresh per call', () => {
  const a = defaultSettings();
  const b = defaultSettings();
  assert.equal(a.masterEnabled, true);
  assert.equal(typeof a.defaults.heartbeat, 'boolean');
  assert.deepEqual(a.recovery, { backoffBaseSec: 5, budgetMin: 30 });
  a.defaults.heartbeatIntervalSec = 999;
  a.sites['x.example.com'] = { enabled: true };
  a.stats['x.example.com'] = { heartbeats: 1 };
  assert.equal(b.defaults.heartbeatIntervalSec, 60, 'mutating one copy must not leak into another');
  assert.equal(Object.keys(b.sites).length, 0);
  assert.deepEqual(b.stats, {}, 'stats map is fresh per call');
});

test('DEFAULT_SITE_BEHAVIOR covers every switchable key', () => {
  for (const key of ALL_BEHAVIOR_KEYS) {
    assert.ok(key in DEFAULT_SITE_BEHAVIOR, `missing behavior key: ${key}`);
  }
});

test('message names are unique', () => {
  const names = Object.values(MSG);
  assert.equal(new Set(names).size, names.length);
});

test('limits are sane', () => {
  assert.ok(LIMITS.heartbeatIntervalSec.min >= 10, 'heartbeat must not hammer servers');
  assert.ok(LIMITS.maxLogEntries > 0);
  assert.ok(LIMITS.maxManagedTabs > 0);
});

test('version fields are in sync across package.json, manifest.json, APP_VERSION and CHANGELOG.md', () => {
  const newestChangelog = changelog.match(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/m)?.[1];
  assert.ok(newestChangelog, 'CHANGELOG.md has a newest version heading');
  assert.equal(pkg.version, APP_VERSION, 'package.json version === APP_VERSION');
  assert.equal(manifest.version, APP_VERSION, 'manifest.json version === APP_VERSION');
  assert.equal(newestChangelog, APP_VERSION, 'CHANGELOG.md newest heading === APP_VERSION');
});
