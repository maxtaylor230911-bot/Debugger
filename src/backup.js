import fs from "node:fs/promises";
import path from "node:path";

export const STATE_DIR = ".debugger";

/**
 * Saves the original version of every file a session touches, so the whole
 * session can be rolled back with `debugger undo`.
 */
export class BackupStore {
  constructor(root, { command = "" } = {}) {
    this.root = root;
    this.id = new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = path.join(root, STATE_DIR, "sessions", this.id);
    this.manifest = { id: this.id, createdAt: new Date().toISOString(), command, undone: false, files: [] };
    this.saved = new Set();
  }

  /** Call before changing `absPath`. Only the first call per file stores a copy. */
  async save(absPath) {
    const rel = path.relative(this.root, absPath);
    if (this.saved.has(rel)) return;
    let original = null;
    try {
      original = await fs.readFile(absPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await this.record(rel, original);
  }

  /** Store a file's original content (null: it didn't exist) for a change already made. */
  async record(rel, original) {
    rel = path.normalize(rel);
    if (this.saved.has(rel)) return;
    if (original !== null) {
      const copy = path.join(this.dir, "files", rel);
      await fs.mkdir(path.dirname(copy), { recursive: true });
      await fs.writeFile(copy, original);
    }
    this.saved.add(rel);
    this.manifest.files.push({ path: rel, existed: original !== null });
    await this.#writeManifest();
  }

  /** Revert everything recorded in this session. */
  async restore() {
    if (this.manifest.files.length === 0) return;
    await restoreFiles(this.root, this.dir, this.manifest.files);
    this.manifest.undone = true;
    await this.#writeManifest();
  }

  get changedFiles() {
    return this.manifest.files.map((f) => f.path);
  }

  async #writeManifest() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, "manifest.json"), JSON.stringify(this.manifest, null, 2));
  }
}

async function restoreFiles(root, sessionDir, files) {
  for (const file of files) {
    const target = path.join(root, file.path);
    if (file.existed) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(sessionDir, "files", file.path), target);
    } else {
      await fs.rm(target, { force: true });
    }
  }
}

/** Restore the most recent session that has not been undone. */
export async function undoLastSession(root) {
  const sessionsDir = path.join(root, STATE_DIR, "sessions");
  let ids;
  try {
    ids = (await fs.readdir(sessionsDir)).sort().reverse();
  } catch {
    return null;
  }
  for (const id of ids) {
    const manifestPath = path.join(sessionsDir, id, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.undone || manifest.files.length === 0) continue;

    await restoreFiles(root, path.join(sessionsDir, id), manifest.files);
    manifest.undone = true;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
  }
  return null;
}
