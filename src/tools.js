import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { lineDiff } from "./diff.js";
import { runCommand, describeRun } from "./runner.js";
import { STATE_DIR } from "./backup.js";

/** Error whose message is returned to Claude as an is_error tool result. */
export class ToolError extends Error {}

const IGNORED_DIRS = new Set([
  ".git", STATE_DIR, "node_modules", "dist", "build", "out", ".next", "coverage",
  "__pycache__", ".venv", "venv", "target", ".gradle", ".idea", ".pytest_cache", ".mypy_cache",
]);
const PROTECTED_DIRS = new Set([".git", STATE_DIR]);
const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

function isOutside(rel) {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

async function realpathOfNearestExisting(abs) {
  let current = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest.reverse());
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) return abs;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function looksBinary(text) {
  return text.slice(0, 8000).includes("\u0000");
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // "*.js" should match at any depth, like most tools.
  return new RegExp(glob.includes("/") ? `^${re}$` : `(^|/)${re}$`);
}

/**
 * The project folder Claude works in. Every path is confined to `root`;
 * every change is shown to the user, approved, and backed up first.
 */
export class Workspace {
  static async create(opts) {
    const ws = new Workspace(opts);
    ws.realRoot = await fs.realpath(ws.root);
    return ws;
  }

  constructor({ root, ui, backups, targetCommand = "", commandTimeoutMs = 120_000 }) {
    this.root = path.resolve(root);
    this.ui = ui;
    this.backups = backups;
    this.targetCommand = targetCommand.trim();
    this.commandTimeoutMs = commandTimeoutMs;
    this.changed = new Set();
  }

  rel(abs) {
    return toPosix(path.relative(this.root, abs)) || ".";
  }

  async resolve(p, { forWrite = false } = {}) {
    if (typeof p !== "string" || p.trim() === "") throw new ToolError("A path is required.");
    const abs = path.resolve(this.root, p);
    const real = await realpathOfNearestExisting(abs);
    if (isOutside(path.relative(this.root, abs)) || isOutside(path.relative(this.realRoot, real))) {
      throw new ToolError(`"${p}" is outside the project folder; only files inside it can be used.`);
    }
    if (forWrite) {
      const first = path.relative(this.root, abs).split(path.sep)[0];
      if (PROTECTED_DIRS.has(first)) throw new ToolError(`Files under ${first}/ cannot be changed.`);
    }
    return abs;
  }

  async #readText(abs, p) {
    let text;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new ToolError(`File not found: ${p}`);
      if (err.code === "EISDIR") throw new ToolError(`${p} is a directory; use list_files.`);
      throw err;
    }
    if (looksBinary(text)) throw new ToolError(`${p} looks like a binary file.`);
    return text;
  }

  async *#walk(dirAbs, depth, maxDepth) {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        yield { abs, dir: true, depth };
        if (depth + 1 < maxDepth) yield* this.#walk(abs, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        yield { abs, dir: false, depth };
      }
    }
  }

  async listFiles({ path: p = ".", max_depth = 3 }) {
    const abs = await this.resolve(p);
    const lines = [];
    const limit = 400;
    for await (const item of this.#walk(abs, 0, Math.min(Math.max(max_depth, 1), 10))) {
      if (lines.length >= limit) {
        lines.push(`[stopped after ${limit} entries; list a subfolder or use search]`);
        break;
      }
      const indent = "  ".repeat(item.depth);
      const name = path.basename(item.abs);
      if (item.dir) lines.push(`${indent}${name}/`);
      else {
        const { size } = await fs.stat(item.abs);
        lines.push(`${indent}${name} (${size} bytes)`);
      }
    }
    return lines.length ? `${this.rel(abs)}/\n${lines.join("\n")}` : `${this.rel(abs)}/ is empty.`;
  }

  async readFile({ path: p, start_line, end_line }) {
    const abs = await this.resolve(p);
    const lines = (await this.#readText(abs, p)).split(/\r?\n/);
    const total = lines.length;
    const start = Math.max(1, start_line ?? 1);
    if (start > total) throw new ToolError(`${p} has only ${total} lines.`);
    const end = Math.min(total, end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => {
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [line truncated]` : line;
        return `${String(start + i).padStart(5)}\t${shown}`;
      })
      .join("\n");
    const more = end < total ? `\n[showing lines ${start}-${end} of ${total}; call again with start_line=${end + 1} for more]` : "";
    return `File: ${this.rel(abs)} (lines ${start}-${end} of ${total})\n${body}${more}`;
  }

  async search({ pattern, path: p = ".", file_glob, case_sensitive = false }) {
    let re;
    try {
      re = new RegExp(pattern, case_sensitive ? "" : "i");
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${err.message}`);
    }
    const globRe = file_glob ? globToRegExp(file_glob) : null;
    const abs = await this.resolve(p);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new ToolError(`Not found: ${p}`);
    const files = [];
    if (stat.isFile()) files.push(abs);
    else for await (const item of this.#walk(abs, 0, 25)) if (!item.dir) files.push(item.abs);

    const matches = [];
    const limit = 100;
    for (const file of files) {
      const rel = this.rel(file);
      if (globRe && !globRe.test(rel)) continue;
      const { size } = await fs.stat(file);
      if (size > MAX_SEARCH_FILE_BYTES) continue;
      const text = await fs.readFile(file, "utf8");
      if (looksBinary(text)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          if (matches.length >= limit) {
            return `${matches.join("\n")}\n[stopped after ${limit} matches; narrow the pattern or path]`;
          }
        }
      }
    }
    return matches.length ? matches.join("\n") : `No matches for /${pattern}/.`;
  }

  async #approveChange(question, diffLines) {
    this.ui.diff(diffLines);
    const { approved, feedback } = await this.ui.confirm(question);
    if (approved) return null;
    return `The user declined this change.${feedback ? ` Their reason: ${feedback}` : ""} Do not retry the same change; adjust your approach or ask in your final report.`;
  }

  async #commit(abs, content) {
    await this.backups.save(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    this.changed.add(this.rel(abs));
  }

  async editFile({ path: p, old_text, new_text, replace_all = false }) {
    const abs = await this.resolve(p, { forWrite: true });
    const content = await this.#readText(abs, p);
    let oldT = old_text;
    let newT = new_text;
    if (content.includes("\r\n") && !old_text.includes("\r\n")) {
      oldT = old_text.replace(/\n/g, "\r\n");
      newT = new_text.replace(/\r?\n/g, "\r\n");
    }
    if (oldT === "") throw new ToolError("old_text must not be empty; use write_file to create files.");
    const count = content.split(oldT).length - 1;
    if (count === 0) {
      throw new ToolError(`old_text was not found in ${p}. Re-read the file and copy the exact text, including whitespace.`);
    }
    if (count > 1 && !replace_all) {
      throw new ToolError(`old_text appears ${count} times in ${p}. Include more surrounding lines to make it unique, or set replace_all.`);
    }
    const updated = replace_all ? content.split(oldT).join(newT) : content.replace(oldT, () => newT);
    if (updated === content) throw new ToolError("The edit would not change the file.");

    this.ui.step(`Proposed edit to ${this.rel(abs)}`);
    const declined = await this.#approveChange(`Apply this edit to ${this.rel(abs)}?`, lineDiff(content, updated));
    if (declined) return declined;
    await this.#commit(abs, updated);
    return `Edited ${this.rel(abs)} (${replace_all ? count : 1} replacement${(replace_all ? count : 1) === 1 ? "" : "s"}).`;
  }

  async writeFile({ path: p, content }) {
    const abs = await this.resolve(p, { forWrite: true });
    let before = null;
    try {
      before = await this.#readText(abs, p);
    } catch (err) {
      if (!(err instanceof ToolError && err.message.startsWith("File not found"))) throw err;
    }
    if (before !== null && before.includes("\r\n") && !content.includes("\r\n")) {
      content = content.replace(/\n/g, "\r\n");
    }
    if (before === content) return `${this.rel(abs)} already has exactly this content.`;

    this.ui.step(before === null ? `Proposed new file ${this.rel(abs)}` : `Proposed rewrite of ${this.rel(abs)}`);
    const declined = await this.#approveChange(
      before === null ? `Create ${this.rel(abs)}?` : `Overwrite ${this.rel(abs)}?`,
      lineDiff(before ?? "", content),
    );
    if (declined) return declined;
    await this.#commit(abs, content);
    return `${before === null ? "Created" : "Rewrote"} ${this.rel(abs)}.`;
  }

  async runCommand({ command, timeout_seconds }) {
    if (command.trim() !== this.targetCommand) {
      const { approved, feedback } = await this.ui.confirm(`Allow Claude to run: ${command}`);
      if (!approved) {
        return `The user did not allow this command.${feedback ? ` Their reason: ${feedback}` : ""}`;
      }
    }
    const timeoutMs = timeout_seconds ? Math.min(timeout_seconds, 600) * 1000 : this.commandTimeoutMs;
    const run = await runCommand(command, { cwd: this.root, timeoutMs });
    return describeRun(command, run);
  }
}

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });

/** Tool specs: what Claude sees, how its input is validated, and how it runs. */
const SPECS = [
  {
    name: "list_files",
    readOnly: true,
    description:
      "List files and folders in the project (dependency and build folders such as node_modules are skipped). Use it to get oriented.",
    properties: {
      path: str("Folder to list, relative to the project root. Default: the root."),
      max_depth: int("How many folder levels deep to list (1-10). Default 3."),
    },
    required: [],
    schema: z.object({ path: z.string().optional(), max_depth: z.number().int().optional() }),
    summary: (i) => i.path ?? ".",
    run: (ws, i) => ws.listFiles(i),
  },
  {
    name: "read_file",
    readOnly: true,
    description:
      "Read a text file, with line numbers. Long files are returned 2000 lines at a time; use start_line/end_line to page or to read around a line from a stack trace.",
    properties: {
      path: str("File path relative to the project root."),
      start_line: int("First line to return (1-based). Optional."),
      end_line: int("Last line to return (inclusive). Optional."),
    },
    required: ["path"],
    schema: z.object({
      path: z.string(),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
    }),
    summary: (i) => i.path + (i.start_line ? `:${i.start_line}-${i.end_line ?? ""}` : ""),
    run: (ws, i) => ws.readFile(i),
  },
  {
    name: "search",
    readOnly: true,
    description:
      "Search file contents with a JavaScript regular expression. Returns path:line: text for each match (up to 100). Use it to find definitions, callers and error messages.",
    properties: {
      pattern: str("Regular expression to search for."),
      path: str("File or folder to search, relative to the project root. Default: the root."),
      file_glob: str('Only search files matching this glob, e.g. "*.py" or "src/**/*.ts".'),
      case_sensitive: bool("Match case exactly. Default false."),
    },
    required: ["pattern"],
    schema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      file_glob: z.string().optional(),
      case_sensitive: z.boolean().optional(),
    }),
    summary: (i) => `/${i.pattern}/${i.file_glob ? ` in ${i.file_glob}` : ""}`,
    run: (ws, i) => ws.search(i),
  },
  {
    name: "edit_file",
    readOnly: false,
    description:
      "Replace exact text in an existing file. old_text must match the file exactly (copy it from read_file without the line numbers) and must be unique unless replace_all is true. The user reviews a diff and must approve it.",
    properties: {
      path: str("File path relative to the project root."),
      old_text: str("The exact text to replace."),
      new_text: str("The replacement text."),
      replace_all: bool("Replace every occurrence instead of exactly one. Default false."),
    },
    required: ["path", "old_text", "new_text"],
    schema: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    }),
    summary: (i) => i.path,
    run: (ws, i) => ws.editFile(i),
  },
  {
    name: "write_file",
    readOnly: false,
    description:
      "Create a new file, or replace a whole file's content. Prefer edit_file for changes to existing files. The user reviews a diff and must approve it.",
    properties: {
      path: str("File path relative to the project root."),
      content: str("The complete file content."),
    },
    required: ["path", "content"],
    schema: z.object({ path: z.string(), content: z.string() }),
    summary: (i) => i.path,
    run: (ws, i) => ws.writeFile(i),
  },
  {
    name: "run_command",
    readOnly: true,
    description:
      "Run a shell command in the project root and get its exit code and output (stdin is closed, so it must not wait for input). Use it to reproduce the failure, run a single test, or check a hypothesis. Anything other than the command being debugged needs the user's approval.",
    properties: {
      command: str("The shell command to run."),
      timeout_seconds: int("Kill the command after this many seconds (max 600). Default 120."),
    },
    required: ["command"],
    schema: z.object({ command: z.string(), timeout_seconds: z.number().int().optional() }),
    summary: (i) => i.command,
    run: (ws, i) => ws.runCommand(i),
  },
];

/**
 * Tools for a session. In "diagnose" mode the file-changing tools are left out.
 * Order is fixed so the tools prefix stays cacheable.
 */
export function buildTools(mode) {
  const specs = SPECS.filter((s) => mode === "fix" || s.readOnly);
  return {
    definitions: specs.map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: { type: "object", properties: s.properties, required: s.required, additionalProperties: false },
      eager_input_streaming: true,
    })),
    byName: new Map(specs.map((s) => [s.name, s])),
  };
}
