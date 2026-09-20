/**
 * UI consistency checks: every element id referenced from popup/options JS
 * must exist in the corresponding HTML, and every relative asset referenced
 * from HTML must resolve to a real file. Catches broken UIs before release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');

const read = (p) => readFileSync(resolve(src, p), 'utf8');

test('popup: every id used by popup.js exists in popup.html', () => {
  const html = read('popup/popup.html');
  const js = read('popup/popup.js');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `popup.js references missing ids: ${missing.join(', ')}`);
});

test('options: every id used by options.js exists in options.html', () => {
  const html = read('options/options.html');
  const js = read('options/options.js');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `options.js references missing ids: ${missing.join(', ')}`);
});

test('options: dynamically composed ids also exist', () => {
  // options.js builds ids like `g-${key}-val` from range data-key attributes.
  const html = read('options/options.html');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const inputs = [...html.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0]);
  for (const tag of inputs) {
    const key = tag.match(/data-key="([^"]+)"/)?.[1];
    if (!key) continue;
    assert.ok(htmlIds.has(`g-${key}`), `range input for ${key} should have id g-${key}`);
    assert.ok(htmlIds.has(`g-${key}-val`), `range input g-${key} needs a g-${key}-val hint element`);
  }
  assert.ok(inputs.length >= 1, 'expected at least one range input in the General form');
});

test('all relative href/src references in extension HTML resolve', () => {
  for (const page of ['popup/popup.html', 'options/options.html']) {
    const dir = dirname(resolve(src, page));
    const html = read(page);
    const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|chrome)/.test(ref)) continue;
      assert.ok(existsSync(resolve(dir, ref)), `${page} references missing file: ${ref}`);
    }
  }
});

test('extension pages declare charset and module scripts load as modules', () => {
  for (const page of ['popup/popup.html', 'options/options.html']) {
    const html = read(page);
    assert.match(html, /<meta charset="utf-8"/i, `${page} missing charset`);
    assert.match(html, /type="module"/, `${page} should load its script as a module`);
  }
});

test('manifest icon files exist and are non-empty PNGs', () => {
  const manifest = JSON.parse(readFileSync(resolve(src, 'manifest.json'), 'utf8'));
  for (const file of Object.values(manifest.icons)) {
    const buf = readFileSync(resolve(src, file));
    assert.ok(buf.length > 100, `${file} too small`);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} not a PNG`);
  }
});

test("options: hydrate does not re-bind general-form listeners", () => {
  const js = read("options/options.js");
  const m = js.match(/async function hydrate\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, "hydrate() exists");
  assert.doesNotMatch(m[0], /bindBehaviorControls\(/, "re-binding on hydrate double-fires after import/reset");
});

test("options: deep-link to a site card uses querySelector, not getElementById", () => {
  const js = read("options/options.js");
  assert.match(js, /querySelector\(`\[data-host-card=/);
  assert.doesNotMatch(js, /\$\(`\[data-host-card=/);
});

test('heartbeat interval bounds in all UIs match LIMITS.heartbeatIntervalSec', () => {
  const LIMITS = (() => {
    const src = read('shared/constants.js');
    const block = src.match(/heartbeatIntervalSec:\s*\{[\s\S]*?\}/m);
    assert.ok(block, 'LIMITS block found');
    const min = block[0].match(/min:\s*(\d+)/);
    const max = block[0].match(/max:\s*(\d+)/);
    assert.ok(min && max, 'LIMITS bounds parseable');
    return { min: Number(min[1]), max: Number(max[1]) };
  })();

  const popup = read('popup/popup.html');
  const popupMatch = popup.match(/<input[^>]*id="interval"[^>]*min="(\d+)"[^>]*max="(\d+)"[^>]*step="(\d+)"/);
  assert.ok(popupMatch, 'popup.html has the interval slider');
  assert.equal(popupMatch[1], String(LIMITS.min), 'popup min matches LIMITS');
  assert.equal(popupMatch[2], String(LIMITS.max), 'popup max matches LIMITS');
  assert.equal(popupMatch[3], '5', 'popup step is 5');

  const general = read('options/options.html');
  const generalMatch = general.match(/<input[^>]*id="g-heartbeatIntervalSec"[^>]*min="(\d+)"[^>]*max="(\d+)"[^>]*step="(\d+)"/);
  assert.ok(generalMatch, 'options.html has the general interval slider');
  assert.equal(generalMatch[1], String(LIMITS.min), 'general min matches LIMITS');
  assert.equal(generalMatch[2], String(LIMITS.max), 'general max matches LIMITS');
  assert.equal(generalMatch[3], '15', 'general step is 15');

  const perSite = read('options/options.js');
  assert.ok(perSite.includes('LIMITS.heartbeatIntervalSec.max'), 'options.js per-site template interpolates LIMITS bounds');
  assert.ok(perSite.includes('LIMITS.heartbeatIntervalSec.min'), 'options.js per-site template interpolates LIMITS min');
  assert.ok(perSite.match(/step="15"/), 'per-site step is 15');
});
