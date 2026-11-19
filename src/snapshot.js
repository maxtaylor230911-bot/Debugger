import fs from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIRS } from "./tools.js";

const toPosix = (p) => p.split(path.sep).join("/");

async function* walk(root, dir = root) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(root, abs);
    } else if (entry.isFile()) {
      yield abs;
    }
  }
}

/**
 * Remember the contents of every project file (dependency/build folders
 * skipped), so changes made by another process can be found, reviewed and
 * reverted. Files over `maxFileBytes` are only fingerprinted.
 */
export async function takeSnapshot(root, { maxFileBytes = 5_000_000, maxTotalBytes = 300_000_000 } = {}) {
  const files = new Map();
  const large = new Map();
  let total = 0;
  for await (const abs of walk(root)) {
    const rel = toPosix(path.relative(root, abs));
    const stat = await fs.stat(abs);
    if (stat.size > maxFileBytes || total + stat.size > maxTotalBytes) {
      large.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
      continue;
    }
    files.set(rel, await fs.readFile(abs));
    total += stat.size;
  }
  return { root, files, large };
}

/** What changed since the snapshot. */
export async function compareSnapshot(snapshot) {
  const { root, files, large } = snapshot;
  const modified = [];
  const created = [];
  const unrestorable = [];
  const seen = new Set();
  for await (const abs of walk(root)) {
    const rel = toPosix(path.relative(root, abs));
    seen.add(rel);
    if (files.has(rel)) {
      const now = await fs.readFile(abs);
      if (!now.equals(files.get(rel))) modified.push(rel);
    } else if (large.has(rel)) {
      const stat = await fs.stat(abs);
      const before = large.get(rel);
      if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) unrestorable.push(rel);
    } else {
      created.push(rel);
    }
  }
  const deleted = [...files.keys()].filter((rel) => !seen.has(rel));
  for (const rel of large.keys()) if (!seen.has(rel)) unrestorable.push(rel);
  const sort = (a) => a.sort();
  return { modified: sort(modified), created: sort(created), deleted: sort(deleted), unrestorable: sort(unrestorable) };
}

export function hasChanges(c) {
  return c.modified.length + c.created.length + c.deleted.length + c.unrestorable.length > 0;
}

/** The content a file had in the snapshot, or null if it didn't exist. */
export function originalOf(snapshot, rel) {
  return snapshot.files.get(rel) ?? null;
}
