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
    let existed = true;
    try {
      const data = await fs.readFile(absPath);
      const copy = path.join(this.dir, "files", rel);
      await fs.mkdir(path.dirname(copy), { recursive: true });
      await fs.writeFile(copy, data);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      existed = false;
    }
    this.saved.add(rel);
    this.manifest.files.push({ path: rel, existed });
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

    for (const file of manifest.files) {
      const target = path.join(root, file.path);
      if (file.existed) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(sessionsDir, id, "files", file.path), target);
      } else {
        await fs.rm(target, { force: true });
      }
    }
    manifest.undone = true;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
  }
  return null;
}
