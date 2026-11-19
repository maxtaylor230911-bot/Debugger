import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT, firstMessage, followUpMessage } from "./agent.js";
import { runCommand, succeeded } from "./runner.js";
import { takeSnapshot, compareSnapshot, hasChanges, originalOf } from "./snapshot.js";
import { lineDiff } from "./diff.js";

/** Raised when Claude Code can't be started or reports an error. */
export class ClaudeCodeError extends Error {}

const CLAUDE_CODE_NOTES = `

Notes for this session:
- Your file edits are applied straight away. When you finish, the user reviews every change and can keep or revert them.
- You can run the command being debugged, optionally with extra arguments (for example to run a single test). Other commands are blocked unless the user allowed them, so don't rely on them.
- Work only inside the project folder.`;

// Session variables that would make the child think it's part of this session,
// and model-alias overrides that would send it to a non-Claude model.
const STRIP_ENV = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
];
const MODEL_ALIAS_ENV = ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];

export function childEnv(env = process.env) {
  const out = { ...env };
  for (const name of STRIP_ENV) delete out[name];
  for (const name of MODEL_ALIAS_ENV) {
    if (out[name] && !/^claude/i.test(out[name])) delete out[name];
  }
  return out;
}

/** Permission rules: the debugged command (plus extra arguments) and anything the user allowed. */
export function allowRules(command, extraAllowed = []) {
  const rules = [];
  for (const cmd of [command, ...extraAllowed].map((c) => c.trim()).filter(Boolean)) {
    for (const tool of ["Bash", "PowerShell"]) rules.push(`${tool}(${cmd})`, `${tool}(${cmd} *)`);
  }
  return rules;
}

function quoteForCmd(arg) {
  return /^[\w.,:\\/=@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function summarize(input, root) {
  if (!input || typeof input !== "object") return "";
  if (input.file_path) return path.relative(root, String(input.file_path)) || String(input.file_path);
  if (input.command) return String(input.command);
  if (input.pattern) return `/${input.pattern}/`;
  if (input.path) return String(input.path);
  return "";
}

/**
 * Run one `claude -p` turn, streaming its progress to the UI.
 * @returns {Promise<{sessionId: string, report: string, isError: boolean, errorText: string, turns: number, usage: object, denials: string[], interrupted: boolean}>}
 */
export function runClaude({ bin, preArgs = [], args, prompt, cwd, ui, env = childEnv(), signal }) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === "win32" && !/\.exe$/i.test(bin);
    const allArgs = [...preArgs, ...args];
    // Windows needs a shell to run the claude.cmd/.ps1 shim; pass it one
    // pre-quoted command line rather than unescaped separate arguments.
    const child = spawn(useShell ? [bin, ...allArgs].map(quoteForCmd).join(" ") : bin, useShell ? [] : allArgs, {
      cwd,
      env,
      shell: useShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const state = { sessionId: "", report: "", isError: false, errorText: "", turns: 0, usage: null, denials: [], interrupted: false };
    let gotResult = false;
    let pending = "";
    let stderr = "";

    const onAbort = () => {
      state.interrupted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const handle = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.session_id) state.sessionId = msg.session_id;
      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) ui.text(`${block.text}\n`);
          else if (block.type === "tool_use") ui.tool(block.name, summarize(block.input, cwd));
        }
      } else if (msg.type === "result") {
        gotResult = true;
        state.report = typeof msg.result === "string" ? msg.result.trim() : "";
        state.isError = Boolean(msg.is_error) || (msg.subtype && msg.subtype !== "success");
        state.errorText = state.isError ? state.report || String(msg.subtype) : "";
        state.turns = msg.num_turns ?? 0;
        state.usage = msg.usage ?? null;
        state.denials = (msg.permission_denials ?? []).map((d) => summarize(d.tool_input, cwd) || d.tool_name);
      }
    };

    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        handle(pending.slice(0, nl).trim());
        pending = pending.slice(nl + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new ClaudeCodeError(`Couldn't start Claude Code (${err.message}). Install it from https://claude.com/claude-code, or set DEBUGGER_CLAUDE_BIN to its path.`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (pending.trim()) handle(pending.trim());
      if (state.interrupted) return resolve(state);
      if (!gotResult) {
        const hint = /not recognized|not found|ENOENT/i.test(stderr)
          ? " Is Claude Code installed? Set DEBUGGER_CLAUDE_BIN if it isn't on your PATH."
          : "";
        return reject(new ClaudeCodeError(`Claude Code exited (code ${code}) without finishing.${hint}\n${stderr.trim()}`.trim()));
      }
      resolve(state);
    });

    child.stdin.end(prompt);
  });
}

async function showChanges(ui, snapshot, changes) {
  for (const rel of [...changes.modified, ...changes.created]) {
    const before = originalOf(snapshot, rel);
    const after = await fs.readFile(path.join(snapshot.root, rel));
    ui.step(before ? `Changed ${rel}` : `Created ${rel}`);
    if (before?.includes(0) || after.includes(0)) ui.info("  (binary file)");
    else ui.diff(lineDiff(before ? before.toString("utf8") : "", after.toString("utf8")));
  }
  for (const rel of changes.deleted) ui.step(`Deleted ${rel}`);
  for (const rel of changes.unrestorable) ui.warn(`Changed ${rel} (too large to back up, so it can't be reverted)`);
}

/**
 * Same investigate → fix → verify loop as the API backend, run through
 * Claude Code (`claude -p`) so it uses the user's Claude subscription.
 */
export async function debugWithClaudeCode({
  root,
  ui,
  backups,
  command,
  problem,
  mode = "fix",
  model,
  effort,
  maxRounds = 3,
  commandTimeoutMs = 120_000,
  allowedCommands = [],
  claudeBin = process.env.DEBUGGER_CLAUDE_BIN || "claude",
  claudePreArgs = [],
  env,
}) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  const exec = () => runCommand(command, { cwd: root, timeoutMs: commandTimeoutMs });
  const changedFiles = new Set();

  ui.step(`Running: ${command}`);
  const initialRun = await exec();
  let finalRun = initialRun;
  const done = (status, extra = {}) => ({ status, report: "", changedFiles: [...changedFiles], usage, rounds: 0, initialRun, finalRun, ...extra });
  if (succeeded(initialRun) && !problem) return done("already_passing");
  ui.info(succeeded(initialRun) ? "The command passes; working on the problem you described." : "It fails. Handing it to Claude Code...\n");

  const snapshot = await takeSnapshot(root);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "debugger-cc-"));
  const settingsPath = path.join(tmp, "settings.json");
  const promptPath = path.join(tmp, "system-prompt.md");
  await fs.writeFile(settingsPath, JSON.stringify({ permissions: { allow: allowRules(command, allowedCommands) } }));
  await fs.writeFile(promptPath, SYSTEM_PROMPT + CLAUDE_CODE_NOTES);

  const tools = mode === "fix" ? "Read,Edit,Write,Glob,Grep,Bash,PowerShell" : "Read,Glob,Grep,Bash,PowerShell";
  const baseArgs = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--restricted",
    "--safe-mode",
    "--tools", tools,
    "--settings", settingsPath,
    "--append-system-prompt-file", promptPath,
    "--permission-mode", mode === "fix" ? "acceptEdits" : "plan",
    "--permission-prompts", "none",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];

  const abort = new AbortController();
  const onSigint = () => {
    ui.warn("Stopping Claude Code...");
    abort.abort();
  };
  process.once("SIGINT", onSigint);

  // Back up originals of anything changed so far (safe even if interrupted).
  const recordChanges = async () => {
    const changes = await compareSnapshot(snapshot);
    for (const rel of [...changes.modified, ...changes.created, ...changes.deleted]) {
      if (!changedFiles.has(rel)) {
        await backups.record(rel, originalOf(snapshot, rel));
        changedFiles.add(rel);
      }
    }
    for (const rel of changes.unrestorable) changedFiles.add(rel);
    return changes;
  };

  let report = "";
  let sessionId = "";
  let status = "still_failing";
  let rounds = 0;
  try {
    let prompt = firstMessage({ mode, command, run: initialRun, problem, root });
    for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      const before = changedFiles.size;
      const result = await runClaude({
        bin: claudeBin,
        preArgs: claudePreArgs,
        args: [...baseArgs, ...(sessionId ? ["--resume", sessionId] : [])],
        prompt,
        cwd: root,
        ui,
        signal: abort.signal,
        ...(env ? { env } : {}),
      });
      sessionId = result.sessionId || sessionId;
      report = result.report || report;
      usage.requests += result.turns;
      usage.input += result.usage?.input_tokens ?? 0;
      usage.output += result.usage?.output_tokens ?? 0;
      usage.cacheRead += result.usage?.cache_read_input_tokens ?? 0;
      usage.cacheWrite += result.usage?.cache_creation_input_tokens ?? 0;
      for (const denied of result.denials) ui.warn(`Blocked: ${denied} (allow more commands with --allow "<command>")`);
      await recordChanges();
      ui.info("");

      if (result.interrupted) {
        status = "interrupted";
        break;
      }
      if (result.isError) throw new ClaudeCodeError(`Claude Code reported an error: ${result.errorText}`);
      if (mode === "diagnose") {
        status = "diagnosed";
        break;
      }
      if (changedFiles.size === before && round === 1) {
        status = "no_changes";
        break;
      }
      ui.step(`Re-running to verify: ${command}`);
      finalRun = await exec();
      if (succeeded(finalRun)) {
        status = "fixed";
        break;
      }
      if (round === maxRounds) break;
      ui.warn(`Still failing (round ${round} of ${maxRounds}). Sending the new output back to Claude Code.\n`);
      prompt = followUpMessage(command, finalRun);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    await fs.rm(tmp, { recursive: true, force: true });
  }

  // Review: keep or revert everything Claude Code changed.
  const changes = await compareSnapshot(snapshot);
  if (hasChanges(changes)) {
    ui.info("Review the changes:");
    await showChanges(ui, snapshot, changes);
    const verdict = succeeded(finalRun) ? "The command passes with these changes." : "The command still fails with these changes.";
    const { approved } = await ui.confirm(`${verdict} Keep them?`);
    if (!approved) {
      await backups.restore();
      changedFiles.clear();
      return done("reverted", { report, rounds });
    }
  }
  return done(status, { report, rounds });
}
