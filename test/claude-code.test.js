import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debugWithClaudeCode, childEnv, allowRules, ClaudeCodeError } from "../src/claude-code.js";
import { BackupStore, undoLastSession } from "../src/backup.js";
import { tempProject, cleanup, quietUI } from "./helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const CHECK = `const v = require("fs").readFileSync("value.txt", "utf8").trim();
if (v !== "ok") { console.error("expected ok, got " + v); process.exit(1); }`;
const COMMAND = "node check.cjs";

async function session(steps, { ui = quietUI(), mode = "fix", files = {}, ...opts } = {}) {
  const root = await tempProject({ "check.cjs": CHECK, "value.txt": "broken\n", ...files });
  const statePath = path.join(root, "..", `${path.basename(root)}-fake-state.json`);
  await fs.writeFile(statePath, JSON.stringify({ steps, calls: [] }));
  const run = () =>
    debugWithClaudeCode({
      root,
      ui,
      backups: new BackupStore(root, { command: COMMAND }),
      command: COMMAND,
      mode,
      model: "claude-opus-5-5",
      effort: "high",
      claudeBin: process.execPath,
      claudePreArgs: [FAKE],
      env: { ...childEnv(), FAKE_CLAUDE_STATE: statePath },
      ...opts,
    });
  const calls = async () => JSON.parse(await fs.readFile(statePath, "utf8")).calls;
  const done = async () => {
    await cleanup(root);
    await fs.rm(statePath, { force: true });
  };
  return { root, run, calls, done, ui };
}

const read = (root, f) => fs.readFile(path.join(root, f), "utf8");

test("claude-code: fixes, verifies, and can be undone", async (t) => {
  const s = await session([{ edits: { "value.txt": "ok\n" }, text: "Root cause: wrong value." }]);
  t.after(s.done);
  const result = await s.run();

  assert.equal(result.status, "fixed");
  assert.deepEqual(result.changedFiles, ["value.txt"]);
  assert.match(result.report, /Root cause/);
  assert.equal(await read(s.root, "value.txt"), "ok\n");

  const [call] = await s.calls();
  for (const flag of ["-p", "--restricted", "--safe-mode", "--verbose"]) assert.ok(call.args.includes(flag), flag);
  const arg = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(arg("--output-format"), "stream-json");
  assert.equal(arg("--model"), "claude-opus-5-5");
  assert.equal(arg("--effort"), "high");
  assert.equal(arg("--permission-mode"), "acceptEdits");
  assert.equal(arg("--permission-prompts"), "none");
  assert.match(arg("--tools"), /Edit/);
  assert.ok(call.settings.permissions.allow.includes(`Bash(${COMMAND})`));
  assert.ok(call.settings.permissions.allow.includes(`PowerShell(${COMMAND} *)`));
  assert.match(call.prompt, /expected ok, got broken/);
  assert.match(call.systemPrompt, /Root cause:/);
  assert.match(call.systemPrompt, /reviews every change/);

  await undoLastSession(s.root);
  assert.equal(await read(s.root, "value.txt"), "broken\n");
});

test("claude-code: a second round resumes the same conversation", async (t) => {
  const s = await session([
    { edits: { "value.txt": "nearly\n" }, text: "First try." },
    { edits: { "value.txt": "ok\n" }, text: "Second try." },
  ]);
  t.after(s.done);
  const result = await s.run();
  assert.equal(result.status, "fixed");
  assert.equal(result.rounds, 2);
  const calls = await s.calls();
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].args.includes("--resume"));
  assert.equal(calls[1].args[calls[1].args.indexOf("--resume") + 1], "fake-session-1");
  assert.match(calls[1].prompt, /still doesn't pass/);
  assert.match(calls[1].prompt, /got nearly/);
});

test("claude-code: rejected changes are all reverted", async (t) => {
  const s = await session(
    [{ edits: { "value.txt": "ok\n", "new-file.js": "x" }, delete: ["check.cjs"], text: "Done." }],
    { ui: quietUI({ autoApprove: false }) },
  );
  t.after(s.done);
  const result = await s.run();
  assert.equal(result.status, "reverted");
  assert.equal(await read(s.root, "value.txt"), "broken\n");
  assert.equal(await read(s.root, "check.cjs"), CHECK);
  await assert.rejects(fs.stat(path.join(s.root, "new-file.js")));
  assert.match(s.ui.out.text, /Review the changes/);
  assert.match(s.ui.out.text, /Created new-file\.js/);
  assert.match(s.ui.out.text, /Deleted check\.cjs/);
});

test("claude-code: diagnose mode can't edit", async (t) => {
  const s = await session([{ text: "Root cause: value.txt should say ok." }], { mode: "diagnose" });
  t.after(s.done);
  const result = await s.run();
  assert.equal(result.status, "diagnosed");
  const [call] = await s.calls();
  const arg = (name) => call.args[call.args.indexOf(name) + 1];
  assert.doesNotMatch(arg("--tools"), /Edit|Write/);
  assert.equal(arg("--permission-mode"), "plan");
});

test("claude-code: blocked commands are reported", async (t) => {
  const s = await session([{ text: "Couldn't run it.", denied: ["npm install"] }]);
  t.after(s.done);
  const result = await s.run();
  assert.equal(result.status, "no_changes");
  assert.match(s.ui.out.text, /Blocked: npm install/);
});

test("claude-code: a crash is reported, not hidden", async (t) => {
  const s = await session([{ crash: true }]);
  t.after(s.done);
  await assert.rejects(s.run(), ClaudeCodeError);
});

test("claude-code: an error result is reported", async (t) => {
  const s = await session([{ isError: true, text: "usage limit reached" }]);
  t.after(s.done);
  await assert.rejects(s.run(), /usage limit reached/);
});

test("childEnv drops session variables and non-Claude model overrides", () => {
  const env = childEnv({
    PATH: "x",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_GIT_BASH_PATH: "C:\\bash.exe",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "Jan-v3.5-4B-Q4_K_XL",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
  });
  assert.equal(env.PATH, "x");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, "C:\\bash.exe");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-5-5");
});

test("allowRules covers the command, its variants, and extra allowed commands", () => {
  assert.deepEqual(allowRules("npm test", ["npm run lint"]), [
    "Bash(npm test)", "Bash(npm test *)", "PowerShell(npm test)", "PowerShell(npm test *)",
    "Bash(npm run lint)", "Bash(npm run lint *)", "PowerShell(npm run lint)", "PowerShell(npm run lint *)",
  ]);
});
