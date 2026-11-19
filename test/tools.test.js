import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Workspace, ToolError, buildTools } from "../src/tools.js";
import { BackupStore, undoLastSession } from "../src/backup.js";
import { lineDiff } from "../src/diff.js";
import { tempProject, cleanup, quietUI } from "./helpers.js";

async function setup(files, uiOpts) {
  const root = await tempProject(files);
  const ws = await Workspace.create({ root, ui: quietUI(uiOpts), backups: new BackupStore(root, { command: "t" }), targetCommand: "node ok.js" });
  return { root, ws };
}

test("paths outside the project are refused", async (t) => {
  const { root, ws } = await setup({ "a.txt": "a" });
  t.after(() => cleanup(root));
  await assert.rejects(ws.readFile({ path: "../outside.txt" }), ToolError);
  await assert.rejects(ws.readFile({ path: path.resolve(root, "..", "x.txt") }), ToolError);
  await assert.rejects(ws.writeFile({ path: "../evil.txt", content: "x" }), ToolError);
  await assert.rejects(ws.writeFile({ path: ".git/config", content: "x" }), /cannot be changed/);
});

test("read_file numbers lines and pages long files", async (t) => {
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
  const { root, ws } = await setup({ "big.txt": lines, "small.txt": "one\ntwo\nthree" });
  t.after(() => cleanup(root));
  const small = await ws.readFile({ path: "small.txt", start_line: 2, end_line: 3 });
  assert.match(small, /2\ttwo/);
  assert.match(small, /3\tthree/);
  assert.doesNotMatch(small, /\tone/);
  const big = await ws.readFile({ path: "big.txt" });
  assert.match(big, /start_line=2001/);
  assert.doesNotMatch(big, /line 2001$/m);
  await assert.rejects(ws.readFile({ path: "missing.txt" }), /File not found/);
});

test("list_files skips dependency folders", async (t) => {
  const { root, ws } = await setup({ "src/app.js": "x", "node_modules/pkg/index.js": "x" });
  t.after(() => cleanup(root));
  const out = await ws.listFiles({});
  assert.match(out, /app\.js/);
  assert.doesNotMatch(out, /node_modules/);
});

test("search finds matches and honours file_glob", async (t) => {
  const { root, ws } = await setup({ "src/a.js": "const total = 1;\n", "src/b.py": "total = 2\n" });
  t.after(() => cleanup(root));
  const all = await ws.search({ pattern: "total" });
  assert.match(all, /src\/a\.js:1:/);
  assert.match(all, /src\/b\.py:1:/);
  const js = await ws.search({ pattern: "TOTAL", file_glob: "*.js" });
  assert.match(js, /a\.js/);
  assert.doesNotMatch(js, /b\.py/);
  await assert.rejects(ws.search({ pattern: "(" }), /Invalid regular expression/);
});

test("edit_file requires a unique exact match", async (t) => {
  const { root, ws } = await setup({ "a.js": "x = 1;\nx = 1;\ny = 2;\n" });
  t.after(() => cleanup(root));
  await assert.rejects(ws.editFile({ path: "a.js", old_text: "x = 1;", new_text: "x = 3;" }), /appears 2 times/);
  await assert.rejects(ws.editFile({ path: "a.js", old_text: "z", new_text: "q" }), /not found/);
  await ws.editFile({ path: "a.js", old_text: "y = 2;", new_text: "y = $&;" });
  await ws.editFile({ path: "a.js", old_text: "x = 1;", new_text: "x = 3;", replace_all: true });
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "x = 3;\nx = 3;\ny = $&;\n");
  assert.deepEqual([...ws.changed], ["a.js"]);
});

test("edit_file keeps Windows line endings", async (t) => {
  const { root, ws } = await setup({ "w.js": "a\r\nb\r\nc\r\n" });
  t.after(() => cleanup(root));
  await ws.editFile({ path: "w.js", old_text: "a\nb", new_text: "a\nB\nb2" });
  assert.equal(await fs.readFile(path.join(root, "w.js"), "utf8"), "a\r\nB\r\nb2\r\nc\r\n");
});

test("declined changes are not written", async (t) => {
  const { root, ws } = await setup({ "a.js": "old" }, { autoApprove: false });
  t.after(() => cleanup(root));
  const result = await ws.editFile({ path: "a.js", old_text: "old", new_text: "new" });
  assert.match(result, /declined/);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "old");
  const cmd = await ws.runCommand({ command: "node -e \"require('fs').writeFileSync('pwned','x')\"" });
  assert.match(cmd, /did not allow/);
  await assert.rejects(fs.stat(path.join(root, "pwned")));
  assert.equal(ws.changed.size, 0);
});

test("the command being debugged runs without asking", async (t) => {
  const { root, ws } = await setup({ "ok.js": "console.log('fine')" }, { autoApprove: false });
  t.after(() => cleanup(root));
  const out = await ws.runCommand({ command: "node ok.js" });
  assert.match(out, /succeeded/);
  assert.match(out, /fine/);
});

test("undo restores edited files and removes created ones", async (t) => {
  const { root, ws } = await setup({ "a.js": "original\n" });
  t.after(() => cleanup(root));
  await ws.editFile({ path: "a.js", old_text: "original", new_text: "changed" });
  await ws.editFile({ path: "a.js", old_text: "changed", new_text: "changed twice" });
  await ws.writeFile({ path: "lib/new.js", content: "created\n" });

  const restored = await undoLastSession(root);
  assert.equal(restored.files.length, 2);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "original\n");
  await assert.rejects(fs.stat(path.join(root, "lib/new.js")));
  assert.equal(await undoLastSession(root), null, "a session is only undone once");
});

test("diagnose mode has no file-changing tools", () => {
  const fix = buildTools("fix").definitions.map((d) => d.name);
  const diagnose = buildTools("diagnose").definitions.map((d) => d.name);
  assert.deepEqual(fix, ["list_files", "read_file", "search", "edit_file", "write_file", "run_command"]);
  assert.deepEqual(diagnose, ["list_files", "read_file", "search", "run_command"]);
  for (const def of buildTools("fix").definitions) {
    assert.equal(def.eager_input_streaming, true);
    assert.equal(def.input_schema.additionalProperties, false);
  }
});

test("lineDiff shows only the changed region", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l10", "L10");
  const diff = lineDiff(before, after);
  assert.ok(diff.includes("- l10"));
  assert.ok(diff.includes("+ L10"));
  assert.ok(diff.some((l) => /unchanged lines/.test(l)));
  assert.ok(!diff.includes("  l0"));
});
