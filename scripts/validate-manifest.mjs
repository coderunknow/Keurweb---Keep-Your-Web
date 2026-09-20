#!/usr/bin/env node
/**
 * Validates src/manifest.json against the MV3 rules Keurweb relies on:
 * required keys, icon files, page references and permission sanity.
 * Exits non-zero on any problem so CI can gate on it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'src/manifest.json');

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`✗ manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

// ---- identity -------------------------------------------------------------
check(manifest.manifest_version === 3, 'manifest_version must be 3');
check(typeof manifest.name === 'string' && manifest.name.length > 0, 'name is required');
check(/^\d+\.\d+\.\d+$/.test(manifest.version ?? ''), `version must be semver, got: ${manifest.version}`);
check(typeof manifest.description === 'string' && manifest.description.length > 0, 'description is required');

// ---- icons ----------------------------------------------------------------
for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  check(existsSync(resolve(root, 'src', file)), `icon ${size}x${size} missing: ${file}`);
}
check(manifest.icons?.['128'], '128px icon is required for the Web Store');

// ---- security-sensitive fields --------------------------------------------
check(!('permissions' in manifest && manifest.permissions.includes('eval')), 'eval is never allowed');
check(
  !JSON.stringify(manifest).includes('unsafe-eval'),
  'unsafe-eval CSP must not appear anywhere in the manifest',
);
check(manifest.content_security_policy === undefined, 'no custom CSP needed — default MV3 policy applies');

// ---- referenced pages exist -----------------------------------------------
const pages = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_ui?.page];
for (const page of pages) {
  check(typeof page === 'string' && existsSync(resolve(root, 'src', page)), `referenced file missing: ${page}`);
}

// ---- permissions used by the code -----------------------------------------
const required = ['storage', 'alarms', 'tabs', 'scripting', 'notifications'];
for (const perm of required) {
  check(manifest.permissions?.includes(perm), `missing required permission: ${perm}`);
}
const allowed = new Set([...required, 'favicon', 'host_permissions']);
for (const perm of manifest.permissions ?? []) {
  check(allowed.has(perm), `unexpected permission: ${perm} (keep the set minimal)`);
}

// ---- background worker shape ----------------------------------------------
check(manifest.background?.type === 'module', 'background.type must be "module" (ES module imports)');
check(manifest.options_ui?.open_in_tab === true, 'options page should open in a tab (dashboard layout)');

// ---- commands --------------------------------------------------------------
for (const [name, cmd] of Object.entries(manifest.commands ?? {})) {
  check(typeof cmd.description === 'string' && cmd.description, `command ${name} needs a description`);
}

// ---- i18n (__MSG_*__ references) -------------------------------------------
const msgRefs = [];
const collectMsgRefs = (value, where) => {
  if (typeof value !== 'string') return;
  for (const m of value.matchAll(/__MSG_([a-zA-Z][\w-]*)__/g)) msgRefs.push({ key: m[1], where });
};
collectMsgRefs(manifest.name, 'name');
collectMsgRefs(manifest.description, 'description');
collectMsgRefs(manifest.action?.default_title, 'action.default_title');
for (const [name, cmd] of Object.entries(manifest.commands ?? {})) {
  collectMsgRefs(cmd.description, `commands.${name}`);
}
if (msgRefs.length) {
  check(typeof manifest.default_locale === 'string' && manifest.default_locale, 'default_locale is required when using __MSG_*__ strings');
  const localePath = resolve(root, 'src', '_locales', manifest.default_locale, 'messages.json');
  check(existsSync(localePath), `missing _locales/${manifest.default_locale}/messages.json`);
  if (existsSync(localePath)) {
    const msgs = JSON.parse(readFileSync(localePath, 'utf8'));
    for (const { key, where } of msgRefs) {
      check(typeof msgs[key]?.message === 'string', `manifest.${where} references unknown i18n key: ${key}`);
    }
  }
}

if (problems.length) {
  console.error(`✗ manifest validation failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('✓ manifest.json is valid (MV3, permissions minimal, all referenced files exist)');
