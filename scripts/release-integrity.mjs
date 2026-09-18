import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_DIRS = new Set(['.git', '.plugin-eval', 'coverage', 'node_modules', 'temp']);
const EXCLUDED_FILES = new Set(['.agent-cache.json']);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkDirectory(dir, base, out) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error('RELEASE_LINK_FORBIDDEN: ' + dir);
  if (!stat.isDirectory()) throw new Error('RELEASE_DIRECTORY_MISSING: ' + dir);
  for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    if (entry.isFile() && EXCLUDED_FILES.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const rel = path.join(base, entry.name).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error('RELEASE_LINK_FORBIDDEN: ' + file);
    if (entry.isDirectory()) walkDirectory(file, rel, out);
    else if (entry.isFile()) out[rel] = sha256(file);
    else throw new Error('RELEASE_ENTRY_UNSUPPORTED: ' + file);
  }
}

function walkFile(file, rel, out) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('RELEASE_LINK_FORBIDDEN: ' + file);
  if (!stat.isFile()) throw new Error('RELEASE_FILE_MISSING: ' + file);
  out[rel.replaceAll('\\', '/')] = sha256(file);
}

export function coreInventory(packageRoot = root) {
  const core = path.join(packageRoot, 'scripts', 'core');
  const files = {};
  walkDirectory(core, '', files);
  if (!files['orchestrate-sdk.mjs'] || !files['contracts.mjs']) throw new Error('RELEASE_CORE_MISSING');
  return files;
}

export function runtimeInventory(packageRoot = root) {
  const files = {};
  for (const rel of ['cli.mjs', 'package.json', 'repair.mjs', 'scripts/recover-stale.mjs']) {
    const file = path.join(packageRoot, rel);
    if (fs.existsSync(file)) walkFile(file, rel, files);
  }
  const scripts = path.join(packageRoot, 'scripts');
  if (fs.existsSync(scripts)) walkDirectory(scripts, 'scripts', files);
  return files;
}

function currentCoreVersion(packageRoot) {
  const text = fs.readFileSync(path.join(packageRoot, 'scripts', 'core', 'contracts.mjs'), 'utf8');
  return /CORE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1] || null;
}

export function verifyRelease(packageRoot = root) {
  const manifestPath = path.join(packageRoot, 'release.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error('RELEASE_MANIFEST_INVALID: ' + (error?.message || String(error)));
  }
  if (manifest.schema !== 2) throw new Error('RELEASE_SCHEMA_UNSUPPORTED');
  const current = coreInventory(packageRoot);
  if (JSON.stringify(current) !== JSON.stringify(manifest.files)) {
    throw new Error('RELEASE_INTEGRITY_FAILED: core differs from the verified release; reinstall the release');
  }
  const version = currentCoreVersion(packageRoot);
  if (!version || manifest.coreVersion !== version) {
    throw new Error('RELEASE_INTEGRITY_FAILED: core version differs from the verified release');
  }
  const runtime = runtimeInventory(packageRoot);
  if (JSON.stringify(runtime) !== JSON.stringify(manifest.runtimeFiles)) {
    throw new Error('RELEASE_INTEGRITY_FAILED: runtime differs from the verified release; reinstall the release');
  }
  return {schema: manifest.schema, coreVersion: manifest.coreVersion, files: Object.keys(current).length, runtimeFiles: Object.keys(runtime).length};
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  if (process.argv.includes('--seal')) {
    const files = coreInventory(root);
    const coreVersion = currentCoreVersion(root);
    if (!coreVersion) throw new Error('Missing core version');
    const runtimeFiles = runtimeInventory(root);
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({schema: 2, coreVersion, files, runtimeFiles}, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(verifyRelease()));
}
