#!/usr/bin/env node
/**
 * repair.mjs - per-skill publish / integrity entry.
 *
 * The CLI package is self-contained and publishable when it carries its
 * executable entrypoint, package metadata, release seal, README and license.
 * Runtime state and developer metadata never enter a published copy.
 *
 * Runtime debris (use-and-discard, never bundled, safe to remove):
 *   node_modules/  temp/  __pycache__/
 *   .pytest_cache/  .cache/
 *   *.part  *.tmp  *.pyc  *.pyo  *.crdownload  *.partial  *.swp
 *   .enforce-state.json  .DS_Store  Thumbs.db
 *
 * Usage:
 *   node repair.mjs                 # integrity check (read-only)
 *   node repair.mjs --clean         # remove runtime debris (use-and-discard only)
 *   node repair.mjs --target <root> # publish: byte-copy the skill folder to <root>/<skill>
 *
 * No third-party deps; Node 22+; all reads/writes UTF-8 (no BOM) for text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRelease } from './scripts/release-integrity.mjs';
import { lockedForMaintenance, acquireMaintenanceLock, releaseMaintenanceLock } from './scripts/core/maintenance-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.basename(__dirname);

const REQUIRED_FILES = ['cli.mjs', 'package.json', 'release.json', 'README.md', 'LICENSE'];
const OPTIONAL_FILES = ['README-zh.md', 'CHANGELOG.md'];

const DEBRIS_DIRS = new Set([
  'node_modules',
  'temp',
  '__pycache__',
  '.pytest_cache',
  '.cache',
]);

const DEBRIS_EXACT = new Set(['.agent-cache.json', '.enforce-state.json', '.DS_Store', 'Thumbs.db']);
const DEBRIS_RE = /\.(part|tmp|pyc|pyo|crdownload|partial|swp)$/i;
const PROTECTED_DIRS = new Set(['.git', '.plugin-eval', 'coverage', 'node_modules', 'temp']);

function listFiles(dir, base = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && PROTECTED_DIRS.has(e.name)) continue;
    if (e.isSymbolicLink()) continue; // 跳过符号链接：不跟随内容复制/删除（防越权/防逃逸）
    const abs = path.join(dir, e.name);
    const rel = path.join(base, e.name);
    if (e.isDirectory()) listFiles(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

// republish 只复制常规文件，不跟随符号链接；校验也保持一致（lstat，不 follow symlink）。
function isRegularFile(p) { try { return fs.lstatSync(p).isFile(); } catch { return false; } }

function isDebrisRel(rel) {
  const parts = rel.split(path.sep);
  if (parts.some((p) => DEBRIS_DIRS.has(p))) return true;
  const base = path.basename(rel);
  if (DEBRIS_EXACT.has(base)) return true;
  if (DEBRIS_RE.test(base)) return true;
  return false;
}

function hasAny(relRoot) {
  const files = listFiles(path.join(__dirname, relRoot));
  return files.some((f) => !isDebrisRel(f));
}

function check() {
  let problems = 0;

  console.log(`[${SKILL}] repair.mjs - self-contained publish / integrity check`);
  console.log(`[${SKILL}] skill root = ${__dirname}`);
  try { const seal = verifyRelease(__dirname); console.log(`  OK  release seal  schema=${seal.schema} core=${seal.coreVersion} files=${seal.files} runtime=${seal.runtimeFiles}`); }
  catch (error) { console.log(`  INVALID release seal  ${error.message}`); problems++; }
  for (const name of REQUIRED_FILES) {
    const full = path.join(__dirname, name);
    const ok = isRegularFile(full);
    const isLink = fs.existsSync(full) && !ok; // 存在但非常规（如符号链接）→ 一致性校验失败
    console.log(`  ${ok ? 'OK ' : 'MISSING'} required  ${name}${isLink ? ' (symlink/not-regular; will not be published)' : ''}`);
    if (!ok) problems++;
  }
  for (const name of OPTIONAL_FILES) {
    if (isRegularFile(path.join(__dirname, name))) {
      console.log(`  OK  optional  ${name}`);
    }
  }
  for (const dir of ['scripts', 'docs', 'test']) {
    const full = path.join(__dirname, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory() && hasAny(dir)) {
      console.log(`  OK  source dir  ${dir}/`);
    }
  }

  const debris = [];
  for (const rel of listFiles(__dirname)) {
    if (isDebrisRel(rel)) debris.push(rel);
  }
  if (debris.length) {
    console.log(`  FOUND ${debris.length} runtime debri item(s) (use-and-discard):`);
    for (const d of debris) console.log(`      ${d}`);
  } else {
    console.log('  OK  no runtime debris');
  }

  console.log('---');
  if (problems) {
    console.log(`[${SKILL}] RESULT: not publishable (${problems} required file(s) missing). Run with --target <root> to publish a clean copy.`);
    process.exit(2);
  }
  console.log(`[${SKILL}] RESULT: publishable${debris.length ? ' (debris present; use --clean to remove)' : ''}.`);
  process.exit(0);
}

function clean() {
  // 维护锁（建议性）：外部未上锁时本操作自行上锁、结束即解；维护会话已持锁则不碰它的锁。
  // 注意 process.exit() 不执行 finally，必须在每个退出点前显式释放。
  const selfLocked = !lockedForMaintenance() && (acquireMaintenanceLock({ reason: 'repair.mjs --clean' }), true);
  try {
    console.log(`[${SKILL}] --clean: removing runtime debris (use-and-discard only; source is untouched)`);
    const removed = [];
    for (const rel of listFiles(__dirname)) {
      if (!isDebrisRel(rel)) continue;
      const abs = path.join(__dirname, rel);
      // Never follow out of the skill root（realpath 兜底，防符号链接逃逸）。
      let real = abs;
      try { real = fs.realpathSync(abs); } catch { continue; } // realpath 失败则无法确认越界，跳过不删
      const rootReal = fs.realpathSync(__dirname);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
      fs.rmSync(abs, { force: true });
      removed.push(rel);
      console.log(`  removed ${rel}`);
    }
    // Also drop now-empty debris dirs (e.g. empty state/, temp/, __pycache__/).
    for (const dir of DEBRIS_DIRS) {
      if (PROTECTED_DIRS.has(dir)) continue;
      const full = path.join(__dirname, dir);
      if (fs.existsSync(full) && !fs.lstatSync(full).isSymbolicLink()) {
        let real = null;
        try { real = fs.realpathSync(full); } catch { continue; }
        const rootReal = fs.realpathSync(__dirname);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
        const empty = fs.readdirSync(full).length === 0;
        if (empty) {
          fs.rmdirSync(full);
          removed.push(dir + '/');
          console.log(`  removed empty dir ${dir}/`);
        }
      }
    }
    console.log(`[${SKILL}] removed ${removed.length} debris item(s).`);
    if (selfLocked) releaseMaintenanceLock();
    process.exit(0);
  } catch (e) {
    if (selfLocked) releaseMaintenanceLock();
    console.error(`[${SKILL}] clean failed: ${e.message}`);
    process.exit(2);
  }
}

function publish(targetRoot) {
  let staging;
  let selfLocked = false;
  try {
    if (!path.isAbsolute(targetRoot)) {
      console.error(`[${SKILL}] --target expects an absolute root, got: ${targetRoot}`);
      process.exit(2);
    }
    // publish 前必须验证必需文件
    const missing = REQUIRED_FILES.filter((nf) => !isRegularFile(path.join(__dirname, nf)));
    if (missing.length) { console.error("[" + SKILL + "] publish aborted: missing " + missing.join(", ")); process.exit(2); }
    // 维护锁（建议性）：外部未上锁时本发布操作自行上锁、结束即解（process.exit 不跑 finally，逐退出点显式释放）。
    selfLocked = !lockedForMaintenance() && (acquireMaintenanceLock({ reason: 'repair.mjs --target publish' }), true);
    verifyRelease(__dirname);
    const dest = path.join(path.resolve(targetRoot), SKILL);
    if (fs.existsSync(dest)) throw new Error('Publish target already exists; choose a fresh version directory');
    const relative = path.relative(__dirname, dest);
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Publish target must be outside the source tree');
    let ancestor = path.dirname(dest), tail = [path.basename(dest)];
    while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    const physical = path.join(fs.realpathSync(ancestor), ...tail);
    const physicalRelative = path.relative(fs.realpathSync(__dirname), physical);
    if (physicalRelative !== '..' && !physicalRelative.startsWith('..' + path.sep) && !path.isAbsolute(physicalRelative)) throw new Error('Publish target must be outside the source tree');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    staging = fs.mkdtempSync(path.join(path.dirname(dest), '.' + SKILL + '-staging-'));
    console.log(`[${SKILL}] --target: publishing CLI package to ${dest}`);
    let copied = 0;
    for (const rel of listFiles(__dirname)) {
      if (isDebrisRel(rel)) continue;
      const srcAbs = path.join(__dirname, rel);
      const dstAbs = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      // Byte-copy: preserves UTF-8 no-BOM text and any binary data byte-exact.
      fs.copyFileSync(srcAbs, dstAbs);
      copied++;
    }
    verifyRelease(staging);
    const stagedMissing = REQUIRED_FILES.filter(name => !isRegularFile(path.join(staging, name)));
    if (stagedMissing.length) throw new Error('Staged package missing required: ' + stagedMissing.join(', '));
    if (fs.existsSync(dest)) throw new Error('Publish target appeared during publication');
    fs.renameSync(staging, dest);
    staging = undefined;
    console.log(`[${SKILL}] published ${copied} file(s) to ${dest}.`);
    if (selfLocked) releaseMaintenanceLock();
    process.exit(0);
  } catch (e) {
    if (selfLocked) releaseMaintenanceLock();
    if (staging) { try { fs.rmSync(staging, {recursive: true, force: true}); } catch { /* preserve the original error */ } }
    console.error(`[${SKILL}] publish failed: ${e.message}`);
    process.exit(2);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--clean')) return clean();
  const ti = args.indexOf('--target');
  if (ti >= 0 && args[ti + 1]) return publish(args[ti + 1]);
  return check();
}

main();
