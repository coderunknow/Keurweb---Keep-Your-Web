#!/usr/bin/env node
/**
 * i18n consistency gate:
 *  - every _locales/<lang>/messages.json parses and is well-formed
 *  - every locale has exactly the same key set as the default locale
 *  - every message uses the same $1…$10 placeholders as the default locale
 *  - every message key referenced from src/** (data-i18n*, t(...),
 *    __MSG_*__ in the manifest, titleKey/messageKey/push log keys) exists
 * Unused keys are reported as warnings (harmless), missing ones fail CI.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');
const localesDir = resolve(srcDir, '_locales');

const problems = [];
const warn = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

function loadLocale(lang) {
  const path = resolve(localesDir, lang, 'messages.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`_locales/${lang}/messages.json: invalid JSON (${error.message})`);
    return null;
  }
}

// ---- load locales ----------------------------------------------------------

const manifest = JSON.parse(readFileSync(resolve(srcDir, 'manifest.json'), 'utf8'));
const defaultLocale = manifest.default_locale ?? 'en';

check(defaultLocale === 'en', `default_locale must stay "en" (the reference locale), got: ${defaultLocale}`);

const languages = existsSync(localesDir) ? readdirSync(localesDir).filter((l) => statSync(join(localesDir, l)).isDirectory()) : [];
check(languages.length >= 2, 'expected at least two locales (en + vi)');
check(languages.includes('en'), 'missing _locales/en');

const messages = {};
for (const lang of languages) {
  messages[lang] = loadLocale(lang);
  if (!messages[lang]) continue;
  for (const [key, entry] of Object.entries(messages[lang])) {
    check(
      entry && typeof entry === 'object' && typeof entry.message === 'string' && entry.message.length > 0,
      `_locales/${lang}: message "${key}" must be an object with a non-empty "message"`,
    );
  }
}
if (!messages[defaultLocale]) {
  console.error(`✗ cannot continue without a parseable ${defaultLocale} locale`);
  process.exit(1);
}

// ---- key set + placeholder parity ------------------------------------------

const enKeys = Object.keys(messages[defaultLocale]);
for (const lang of languages) {
  if (lang === defaultLocale || !messages[lang]) continue;
  const keys = Object.keys(messages[lang]);
  const missing = enKeys.filter((k) => !(k in messages[lang]));
  const extra = keys.filter((k) => !(k in messages[defaultLocale]));
  check(missing.length === 0, `_locales/${lang}: missing keys: ${missing.join(', ')}`);
  check(extra.length === 0, `_locales/${lang}: keys not in en: ${extra.join(', ')}`);
}

const placeholders = (text) => [...text.matchAll(/\$(?:10|[1-9])/g)].map((m) => m[0]).sort();
for (const lang of languages) {
  if (lang === defaultLocale || !messages[lang]) continue;
  for (const key of enKeys) {
    const enPh = placeholders(messages[defaultLocale][key]?.message ?? '');
    const ph = placeholders(messages[lang][key]?.message ?? '');
    check(
      JSON.stringify(enPh) === JSON.stringify(ph),
      `_locales/${lang}["${key}"]: placeholders ${ph.join(',')} ≠ en ${enPh.join(',')}`,
    );
  }
}

// ---- referenced keys must exist --------------------------------------------

const referenced = new Set();
const pushRef = (key, where) => {
  if (!/^[a-zA-Z][\w-]*$/.test(key)) return;
  referenced.add(key);
  if (!(key in messages[defaultLocale])) problems.push(`${where}: unknown i18n key "${key}"`);
};

// manifest __MSG_*__
for (const [field, value] of [
  ['name', manifest.name],
  ['description', manifest.description],
  ['action.default_title', manifest.action?.default_title],
]) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/__MSG_([a-zA-Z][\w-]*)__/g)) pushRef(m[1], `manifest.${field}`);
  }
}
for (const [name, cmd] of Object.entries(manifest.commands ?? {})) {
  for (const m of String(cmd.description ?? '').matchAll(/__MSG_([a-zA-Z][\w-]*)__/g)) pushRef(m[1], `manifest.commands.${name}`);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (['.js', '.html'].includes(extname(p))) out.push(p);
  }
  return out;
}

for (const file of walk(srcDir)) {
  const rel = relative(root, file);
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(/__MSG_([a-zA-Z][\w-]*)__/g)) pushRef(m[1], rel);
  for (const m of code.matchAll(/data-i18n(?:-ph|-title|-aria)?="([^"]+)"/g)) pushRef(m[1], rel);
  for (const m of code.matchAll(/\bt\(\s*['"]([a-zA-Z][\w-]*)['"]/g)) pushRef(m[1], rel);
  for (const m of code.matchAll(/\btitleKey:\s*['"]([a-zA-Z][\w-]*)['"]/g)) pushRef(m[1], rel);
  for (const m of code.matchAll(/\bmessageKey:\s*['"]([a-zA-Z][\w-]*)['"]/g)) pushRef(m[1], rel);
  for (const m of code.matchAll(/\.push\(\s*'(?:info|warn|error)',\s*['"]([a-zA-Z][\w-]*)['"]/g)) pushRef(m[1], rel);
  // Loose pass: any string literal in the code that matches a known key
  // (covers dynamic shapes like `push(level, cond ? 'a' : 'b', ...)`).
  for (const m of code.matchAll(/['"]([a-zA-Z][\w-]{2,})['"]/g)) {
    if (m[1] in messages[defaultLocale]) referenced.add(m[1]);
  }
}

// ---- unused keys (warning only) --------------------------------------------

for (const key of enKeys) {
  if (!referenced.has(key)) warn.push(`unused key: ${key}`);
}

if (problems.length) {
  console.error(`✗ i18n check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
if (warn.length) {
  console.warn(`⚠ ${warn.length} unused message key(s):`);
  for (const w of warn) console.warn(`  - ${w}`);
}
console.log(`✓ i18n consistent: ${languages.join(', ')} (${enKeys.length} keys, all references resolve)`);
