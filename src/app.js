import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { TerminalUI, color } from "./ui.js";
import { InspectSession, workingName } from "./inspect.js";
import { debugWithClaudeCode, ClaudeCodeError } from "./claude-code.js";
import { BackupStore } from "./backup.js";
import { lineDiff } from "./diff.js";
import { DEFAULT_MODEL, DEFAULT_EFFORT } from "./agent.js";
import { printSummary } from "./main.js";

const MAX_DIFF_LINES = 400;

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

/** Strip the quotes Windows adds when a file is dragged into the console. */
export function cleanPath(input) {
  return (input ?? "").trim().replace(/^&\s*/, "").replace(/^["']|["']$/g, "").trim();
}

async function uniquePath(p) {
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? p : path.join(dir, `${name} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

function describeSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

class App {
  constructor({ ui, downloads, claude }) {
    this.ui = ui;
    this.downloads = downloads;
    this.reports = path.join(downloads, "Debugger reports");
    this.claude = claude; // { model, effort, claudeBin, claudePreArgs, env }
  }

  async choose(question, options, fallback = "1") {
    this.ui.info(question);
    options.forEach((o, i) => this.ui.info(`  ${color.bold(i + 1)}) ${o}`));
    for (;;) {
      const raw = await this.ui.ask(`Choose 1-${options.length}${fallback ? ` [${fallback}]` : ""}: `);
      if (raw === null) return null;
      const answer = raw.trim() || fallback;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
      this.ui.warn(`Please type a number from 1 to ${options.length}.`);
    }
  }

  async run() {
    this.ui.info(color.bold("\nDebugger — find and fix bugs with Claude"));
    this.ui.info(color.dim("Runs on your Claude subscription through Claude Code. Press Ctrl+C to stop Claude at any time.\n"));
    for (;;) {
      const options = [
        "Inspect a file (drag it into this window, or type its path)",
        "Paste code into this window",
        ...(process.platform === "win32" ? ["Paste code into Notepad (best for very large code)"] : []),
        "Fix a failing command in a project folder",
        "Quit",
      ];
      const pick = await this.choose("What would you like to do?", options);
      const action = pick === null ? "Quit" : options[pick - 1];
      if (action === "Quit") break;
      try {
        if (action.startsWith("Inspect")) await this.inspectFile();
        else if (action.startsWith("Paste code into this")) await this.pasteHere();
        else if (action.startsWith("Paste code into Notepad")) await this.pasteNotepad();
        else await this.fixCommand();
      } catch (err) {
        if (err instanceof ClaudeCodeError) this.ui.error(err.message);
        else this.ui.error(`Something went wrong: ${err.message}`);
      }
      const again = await this.ui.ask("\nDo something else? [Y/n] ");
      if (again === null || /^n/i.test(again.trim())) break;
      this.ui.info("");
    }
  }

  async inspectFile() {
    const raw = await this.ui.ask("File to inspect (drag it here, or type the path): ");
    const file = path.resolve(cleanPath(raw));
    if (!cleanPath(raw)) return;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return this.ui.error(`File not found: ${file}`);
    if (stat.isDirectory()) return this.ui.error("That's a folder. Pick a file, or use 'Fix a failing command in a project folder'.");
    const data = await fs.readFile(file);
    if (data.subarray(0, 8000).includes(0)) return this.ui.error("That looks like a binary file (an app, image or archive), not code.");
    this.ui.info(color.dim(`Loaded ${path.basename(file)} (${describeSize(stat.size)}).`));
    await this.inspect({ name: path.basename(file), content: data.toString("utf8"), source: file });
  }

  async pasteHere() {
    this.ui.info("Paste your code, then type END on a line by itself and press Enter:");
    const content = await this.ui.readBlock("END");
    if (!content.trim()) return this.ui.warn("Nothing was pasted.");
    this.ui.info(color.dim(`Got ${content.split("\n").length} lines.`));
    await this.inspect({ name: await this.askFileName(), content, source: null });
  }

  async pasteNotepad() {
    const temp = path.join(os.tmpdir(), `debugger-paste-${stamp()}.txt`);
    await fs.writeFile(temp, "");
    spawn("notepad.exe", [temp], { detached: true, stdio: "ignore" }).unref();
    this.ui.info("Notepad is opening. Paste your code into it, save with Ctrl+S, then come back here.");
    await this.ui.ask("Press Enter when you've saved... ");
    const content = await fs.readFile(temp, "utf8").catch(() => "");
    await fs.rm(temp, { force: true });
    if (!content.trim()) return this.ui.warn("The Notepad file was empty. Did you save it with Ctrl+S?");
    this.ui.info(color.dim(`Got ${content.split(/\r?\n/).length} lines.`));
    await this.inspect({ name: await this.askFileName(), content, source: null });
  }

  async askFileName() {
    const ext = ((await this.ui.ask("What language is it? Type an extension like py, js, cs (or press Enter to skip): ")) ?? "")
      .trim()
      .replace(/^\./, "")
      .replace(/[^\w+-]/g, "");
    return `pasted-code.${ext || "txt"}`;
  }

  async inspect({ name, content, source }) {
    const modePick = await this.choose("\nWhat should Claude do?", [
      "Find the bugs and fix them (you choose whether to save the fixes)",
      "Review only: explain the problems, change nothing",
    ]);
    if (modePick === null) return;
    const mode = modePick === 1 ? "fix" : "review";
    const question = ((await this.ui.ask("What's wrong, or what should it look for? (press Enter for a full bug review): ")) ?? "").trim();

    const session = await InspectSession.create({ ui: this.ui, name, content, mode, ...this.claude });
    try {
      this.ui.step(`Claude is reading ${session.fileName}...`);
      const first = await session.start(question);
      if (first.interrupted) return this.ui.warn("Stopped.");

      await fs.mkdir(this.reports, { recursive: true });
      const reportPath = await uniquePath(path.join(this.reports, `${path.parse(session.fileName).name}-${stamp()}.md`));
      const header = `# Debugger report: ${session.fileName}\n\n${source ? `File: ${source}\n` : "Pasted code\n"}Mode: ${mode}\n${question ? `Question: ${question}\n` : ""}\n`;
      await fs.writeFile(reportPath, `${header}${first.report}\n`);
      this.ui.success(`Report saved: ${reportPath}`);

      for (;;) {
        const q = ((await this.ui.ask("\nAsk a follow-up about this code (or press Enter to finish): ")) ?? "").trim();
        if (!q) break;
        const answer = await session.followUp(q);
        if (answer.interrupted) break;
        await fs.appendFile(reportPath, `\n## Follow-up: ${q}\n\n${answer.report}\n`);
      }

      if (mode === "fix") await this.offerSave(session, content, source);
    } finally {
      await session.dispose();
    }
  }

  async offerSave(session, original, source) {
    const fixed = await session.current();
    if (fixed === null || fixed === original) return this.ui.info(color.dim("No changes were made to the code."));

    this.ui.step("Changes Claude made:");
    const diff = lineDiff(original, fixed);
    this.ui.diff(diff.slice(0, MAX_DIFF_LINES));
    if (diff.length > MAX_DIFF_LINES) this.ui.info(color.dim(`  ... ${diff.length - MAX_DIFF_LINES} more diff lines not shown`));

    if (source) {
      const { dir, name, ext } = path.parse(source);
      const pick = await this.choose("\nSave the fixed code?", [
        `Save as a new file: ${name}.fixed${ext}`,
        `Overwrite ${name}${ext} (the original is kept as ${name}${ext}.bak)`,
        "Don't save",
      ]);
      if (pick === 1) {
        const out = await uniquePath(path.join(dir, `${name}.fixed${ext}`));
        await fs.writeFile(out, fixed);
        this.ui.success(`Saved ${out}`);
      } else if (pick === 2) {
        const bak = await uniquePath(`${source}.bak`);
        await fs.copyFile(source, bak);
        await fs.writeFile(source, fixed);
        this.ui.success(`Saved ${source} (original kept as ${bak})`);
      } else {
        this.ui.info("Not saved.");
      }
    } else {
      const { name, ext } = path.parse(session.fileName);
      const target = path.join(this.downloads, `${name}-fixed-${stamp()}${ext}`);
      const pick = await this.choose("\nSave the fixed code?", [`Save to ${target}`, "Don't save"]);
      if (pick === 1) {
        const out = await uniquePath(target);
        await fs.writeFile(out, fixed);
        this.ui.success(`Saved ${out}`);
      } else {
        this.ui.info("Not saved.");
      }
    }
  }

  async fixCommand() {
    const folder = path.resolve(cleanPath(await this.ui.ask("Project folder (drag it here, or type the path): ")));
    const stat = await fs.stat(folder).catch(() => null);
    if (!stat?.isDirectory()) return this.ui.error(`Folder not found: ${folder}`);
    const command = ((await this.ui.ask('Command that fails (for example: npm test, python app.py): ')) ?? "").trim();
    if (!command) return;
    const problem = ((await this.ui.ask("Describe the problem (or press Enter to skip): ")) ?? "").trim();
    const result = await debugWithClaudeCode({
      root: folder,
      ui: this.ui,
      backups: new BackupStore(folder, { command }),
      command,
      problem: problem || undefined,
      ...this.claude,
    });
    printSummary(this.ui, result, command);
  }
}

/** The interactive app shown when Debugger.exe is double-clicked. */
export async function runApp({
  ui = new TerminalUI({ interactive: true }),
  downloads = path.join(os.homedir(), "Downloads"),
  claude = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT },
  pauseAtEnd = true,
} = {}) {
  const app = new App({ ui, downloads, claude });
  try {
    await app.run();
    if (pauseAtEnd) await ui.ask("\nPress Enter to close this window. ");
    return 0;
  } finally {
    ui.close();
  }
}

export { workingName };
