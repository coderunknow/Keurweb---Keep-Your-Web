#!/usr/bin/env node
/**
 * Syntax + hygiene check for every JS file that ships in the extension.
 * Parses each file (catches syntax errors) and flags common MV3 worker
 * mistakes that would only surface at runtime in the browser.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (extname(p) === '.js') out.push(p);
  }
  return out;
}

const problems = [];
const files = walk(srcDir);

for (const file of files) {
  const rel = relative(root, file);
  const code = readFileSync(file, 'utf8');

  // Parse as an ES module (package.json sets type:module) — catches syntax errors.
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${rel}: syntax error: ${String(error.stderr)}`);
    continue;
  }

  const isWorker = rel.endsWith('background/serviceWorker.js');
  if (isWorker) {
    if (/\bwindow\./.test(code)) problems.push(`${rel}: service worker must not use window (use self/chrome)`);
    if (/\bdocument\./.test(code)) problems.push(`${rel}: service worker must not touch document`);
    if (/\blocalStorage\b/.test(code)) problems.push(`${rel}: localStorage does not exist in workers — use chrome.storage`);
  }
  if (/\bXMLHttpRequest\b/.test(code)) problems.push(`${rel}: use fetch, not XMLHttpRequest`);
  if (/innerHTML\s*=\s*[^'"`]/.test(code) && !/innerHTML\s*=\s*('|"|`)/.test(code)) {
    problems.push(`${rel}: suspicious innerHTML assignment with non-literal value`);
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✓ ${files.length} JS files parse cleanly, no worker/DOM violations`);
