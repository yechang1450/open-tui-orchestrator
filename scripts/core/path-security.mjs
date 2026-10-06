import fs from 'node:fs';
import path from 'node:path';

const isMissing = error => error?.code === 'ENOENT';

// Resolve the existing ancestor of a path while preserving a missing leaf.
// lstat is intentional: existsSync/stat cannot see a dangling junction, so they
// would incorrectly treat a link to a deleted target as an ordinary missing path.
export function realpathWithMissing(target) {
  let current = path.resolve(String(target));
  const tail = [];
  for (;;) {
    let entry;
    try {
      entry = fs.lstatSync(current);
    } catch (error) {
      if (!isMissing(error)) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      // This includes a dangling symlink/junction at the first existing path.
      return null;
    }
  }
}

export function containedBy(base, target) {
  if (!base || !target) return false;
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(fold(path.resolve(base)), fold(path.resolve(target)));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

// Return the first existing symlink/junction component, including a dangling
// final component or a link hidden above a missing descendant.
export function findSymlinkComponent(target) {
  let current = path.resolve(String(target));
  for (;;) {
    try {
      return fs.lstatSync(current).isSymbolicLink() ? current : null;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export function assertNoSymlinkComponents(target) {
  const link = findSymlinkComponent(target);
  if (link) throw new Error('Unsafe path through symlink or junction: ' + link);
}
