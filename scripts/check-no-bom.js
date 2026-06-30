#!/usr/bin/env node
// Fails the build if any source file starts with a UTF-8 BOM (EF BB BF).
// BOM-prefixed agent files break Claude Code's frontmatter loader silently —
// the loader expects `---` at byte 0 and skips files with a BOM. Pass --fix
// to strip the BOM in place.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = ['.claude', '.github', 'content', 'core', 'lore', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const EXTS = new Set(['.md', '.js', '.json', '.yml', '.yaml']);

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot) : '';
      if (EXTS.has(ext)) yield join(dir, entry.name);
    }
  }
}

const fix = process.argv.includes('--fix');
const offenders = [];

for (const root of ROOTS) {
  for await (const file of walk(resolve(repoRoot, root))) {
    const buf = await readFile(file);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      offenders.push(file);
      if (fix) await writeFile(file, buf.subarray(3));
    }
  }
}

if (offenders.length === 0) {
  console.log('BOM check: clean');
  process.exit(0);
}

const verb = fix ? 'stripped BOM from' : 'BOM found in';
for (const f of offenders) console.log(`  ${verb} ${relative(repoRoot, f)}`);

if (fix) {
  console.log(`\nFixed ${offenders.length} file(s).`);
  process.exit(0);
}

console.error(`\nBOM check FAILED: ${offenders.length} file(s) start with a UTF-8 BOM.`);
console.error('Run `node scripts/check-no-bom.js --fix` to strip them.');
process.exit(1);
