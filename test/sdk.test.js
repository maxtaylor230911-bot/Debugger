// Drives the real Anthropic SDK against a local mock of the Messages API, to
// check the exact request we send and that streamed tool calls are parsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { debugSession } from "../src/agent.js";
import { Workspace } from "../src/tools.js";
import { BackupStore } from "../src/backup.js";
import { tempProject, cleanup, quietUI } from "./helpers.js";

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function streamedMessage(blocks, stopReason) {
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      // Split the JSON to exercise incremental (eager) input streaming.
      for (const part of [json.slice(0, 10), json.slice(10)]) {
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } });
      }
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  events.push({ type: "message_stop" });
  return sse(events);
}

test("real SDK: request shape and streamed tool calls", async (t) => {
  const responses = [
    streamedMessage([{ type: "tool_use", id: "tu_1", name: "edit_file", input: { path: "value.txt", old_text: "broken", new_text: "ok" } }], "tool_use"),
    streamedMessage([{ type: "text", text: "Root cause: wrong value." }], "end_turn"),
  ];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responses.shift());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const root = await tempProject({
    "check.cjs": `process.exit(require("fs").readFileSync("value.txt","utf8").trim() === "ok" ? 0 : 1)`,
    "value.txt": "broken\n",
  });
  t.after(() => cleanup(root));
  const ui = quietUI();
  const command = "node check.cjs";
  const workspace = await Workspace.create({ root, ui, backups: new BackupStore(root), targetCommand: command });
  const client = new Anthropic({ apiKey: "test-key", baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });

  const result = await debugSession({ client, workspace, ui, command });

  assert.equal(result.status, "fixed");
  assert.equal(await fs.readFile(path.join(root, "value.txt"), "utf8"), "ok\n");
  assert.equal(requests.length, 2);

  const [first, second] = requests;
  assert.match(first.url, /^\/v1\/messages/);
  assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(first.body.stream, true);
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.equal(first.body.fallbacks, "default");
  assert.equal(first.body.betas, undefined, "betas travel as a header, not in the body");
  assert.deepEqual(first.body.thinking, { type: "adaptive", display: "summarized" });
  assert.ok(first.body.tools.every((tool) => tool.eager_input_streaming === true));

  const toolResult = second.body.messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "tu_1");
  assert.match(toolResult.content, /Edited value\.txt/);
  assert.deepEqual(second.body.messages[1].content[0].input, { path: "value.txt", old_text: "broken", new_text: "ok" });
});
