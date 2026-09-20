#!/usr/bin/env node
/**
 * Packages the extension into dist/keurweb-v<version>.zip
 * (exactly the contents of src/, i.e. load-ready for Brave/Chrome).
 */
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');
const distDir = resolve(root, 'dist');

const manifest = JSON.parse(readFileSync(resolve(srcDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`✗ bad version in manifest: ${version}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

mkdirSync(distDir, { recursive: true });
const zipPath = resolve(distDir, `keurweb-v${version}.zip`);
const files = walk(srcDir);

// Stage a clean directory so the zip contains exactly the extension files.
const stage = resolve(distDir, 'stage');
execFileSync('rm', ['-rf', stage]);
mkdirSync(stage, { recursive: true });
for (const file of files) {
  const target = resolve(stage, relative(srcDir, file));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
}

execFileSync('zip', ['-r', '-X', zipPath, '.'], { cwd: stage, stdio: 'pipe' });
execFileSync('rm', ['-rf', stage]);

console.log(`✓ packaged ${files.length} files → dist/keurweb-v${version}.zip`);
