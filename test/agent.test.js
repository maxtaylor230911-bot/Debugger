import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { debugSession, DEFAULT_MODEL } from "../src/agent.js";
import { Workspace } from "../src/tools.js";
import { BackupStore } from "../src/backup.js";
import { tempProject, cleanup, quietUI, fakeClient, message, toolUse, text } from "./helpers.js";

// A project whose "test" passes only when value.txt contains "ok".
const CHECK = `const v = require("fs").readFileSync("value.txt", "utf8").trim();
if (v !== "ok") { console.error("expected ok, got " + v); process.exit(1); }
console.log("all good");`;
const COMMAND = "node check.cjs";

async function session(script, { mode = "fix", files = {}, ui = quietUI(), ...opts } = {}) {
  const root = await tempProject({ "check.cjs": CHECK, "value.txt": "broken\n", ...files });
  const workspace = await Workspace.create({ root, ui, backups: new BackupStore(root, { command: COMMAND }), targetCommand: COMMAND });
  const client = fakeClient(script);
  const result = await debugSession({ client, workspace, ui, command: COMMAND, mode, ...opts });
  return { root, client, result, ui };
}

const read = (root, f) => fs.readFile(path.join(root, f), "utf8");

test("fixes the bug, then proves it by re-running the command", async (t) => {
  const thinking = { type: "thinking", thinking: "The value file is wrong.", signature: "sig" };
  const { root, client, result } = await session([
    message([thinking, toolUse("t1", "read_file", { path: "value.txt" })], "tool_use"),
    message([toolUse("t2", "edit_file", { path: "value.txt", old_text: "broken", new_text: "ok" })], "tool_use"),
    message([text("Root cause: value.txt held the wrong value.")], "end_turn"),
  ]);
  t.after(() => cleanup(root));

  assert.equal(result.status, "fixed");
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.changedFiles, ["value.txt"]);
  assert.equal(await read(root, "value.txt"), "ok\n");
  assert.match(result.report, /Root cause/);
  assert.equal(result.usage.requests, 3);

  const first = client.calls[0];
  assert.equal(first.model, DEFAULT_MODEL);
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first.fallbacks, "default");
  assert.deepEqual(first.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(first.output_config.effort, "high");
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
  assert.equal(first.tools.length, 6);
  assert.match(first.messages[0].content, /expected ok, got broken/);

  // The assistant turn (with its thinking block) is echoed back unchanged,
  // followed by the tool results.
  const second = client.calls[1].messages;
  assert.deepEqual(second[1].content[0], thinking);
  assert.equal(second[2].content[0].type, "tool_result");
  assert.equal(second[2].content[0].tool_use_id, "t1");
  assert.match(second[2].content[0].content, /1\tbroken/);
});

test("sends the new failure back when the first fix isn't enough", async (t) => {
  const { root, client, result } = await session([
    message([toolUse("t1", "edit_file", { path: "value.txt", old_text: "broken", new_text: "nearly" })], "tool_use"),
    message([text("Changed the value.")], "end_turn"),
    message([toolUse("t2", "edit_file", { path: "value.txt", old_text: "nearly", new_text: "ok" })], "tool_use"),
    message([text("Fixed properly this time.")], "end_turn"),
  ]);
  t.after(() => cleanup(root));

  assert.equal(result.status, "fixed");
  assert.equal(result.rounds, 2);
  const followUp = client.calls[2].messages.at(-1);
  assert.equal(followUp.role, "user");
  assert.match(followUp.content, /still doesn't pass/);
  assert.match(followUp.content, /got nearly/);
});

test("gives up after the round limit", async (t) => {
  const { root, result } = await session(
    [
      message([toolUse("t1", "edit_file", { path: "value.txt", old_text: "broken", new_text: "still-wrong" })], "tool_use"),
      message([text("Tried something.")], "end_turn"),
    ],
    { maxRounds: 1 },
  );
  t.after(() => cleanup(root));
  assert.equal(result.status, "still_failing");
});

test("diagnose mode explains without changing files", async (t) => {
  const { root, client, result } = await session(
    [message([text("Root cause: value.txt should say ok.\n\n```diff\n-broken\n+ok\n```")], "end_turn")],
    { mode: "diagnose" },
  );
  t.after(() => cleanup(root));
  assert.equal(result.status, "diagnosed");
  assert.equal(await read(root, "value.txt"), "broken\n");
  assert.deepEqual(
    client.calls[0].tools.map((t) => t.name),
    ["list_files", "read_file", "search", "run_command"],
  );
  assert.match(client.calls[0].messages[0].content, /diagnose-only/);
});

test("doesn't call Claude when the command already passes", async (t) => {
  const { root, client, result } = await session([], { files: { "value.txt": "ok" } });
  t.after(() => cleanup(root));
  assert.equal(result.status, "already_passing");
  assert.equal(client.calls.length, 0);
});

test("invalid tool input comes back as an error the model can correct", async (t) => {
  const { root, client, result } = await session([
    message([toolUse("t1", "read_file", { file: "value.txt" })], "tool_use"),
    message([text("I could not fix it.")], "end_turn"),
  ]);
  t.after(() => cleanup(root));
  assert.equal(result.status, "no_changes");
  const toolResult = client.calls[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /INVALID_JSON/);
});

test("tools in a refused turn are never run", async (t) => {
  const { root, result } = await session([
    message([toolUse("t1", "edit_file", { path: "value.txt", old_text: "broken", new_text: "ok" })], "refusal"),
  ]);
  t.after(() => cleanup(root));
  assert.equal(result.status, "refusal");
  assert.equal(await read(root, "value.txt"), "broken\n");
});

test("a response that can't be parsed is retried", async (t) => {
  const { root, result } = await session([
    new Error("Unable to parse tool parameter JSON"),
    message([toolUse("t1", "edit_file", { path: "value.txt", old_text: "broken", new_text: "ok" })], "tool_use"),
    message([text("Done.")], "end_turn"),
  ]);
  t.after(() => cleanup(root));
  assert.equal(result.status, "fixed");
});

test("errors before the response starts (e.g. no API key) are not retried", async (t) => {
  const root = await tempProject({ "check.cjs": CHECK, "value.txt": "broken\n" });
  t.after(() => cleanup(root));
  const ui = quietUI();
  const workspace = await Workspace.create({ root, ui, backups: new BackupStore(root), targetCommand: COMMAND });
  const client = fakeClient([{ beforeConnect: new Error("Could not resolve authentication method") }]);
  await assert.rejects(debugSession({ client, workspace, ui, command: COMMAND }), /authentication/);
  assert.equal(client.calls.length, 1);
  assert.doesNotMatch(ui.out.text, /retrying/);
});

test("stops at the step limit", async (t) => {
  const loop = Array.from({ length: 3 }, (_, i) => message([toolUse(`t${i}`, "list_files", {})], "tool_use"));
  const { root, result } = await session(loop, { maxTurns: 3 });
  t.after(() => cleanup(root));
  assert.equal(result.status, "turn_limit");
});
