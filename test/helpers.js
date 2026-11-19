import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TerminalUI } from "../src/ui.js";

export async function tempProject(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "debugger-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** A UI that records output instead of printing it. */
export function quietUI({ autoApprove = true } = {}) {
  const out = { text: "", write(s) { this.text += s; } };
  const input = { isTTY: false };
  return new TerminalUI({ autoApprove, out, input });
}

export function message(content, stop_reason, extra = {}) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    ...extra,
  };
}

export const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
export const text = (t) => ({ type: "text", text: t });

/**
 * Fake Anthropic client: each stream() call takes the next scripted step.
 * A step is a message, an Error to throw, or a function(params) -> message.
 */
export function fakeClient(script) {
  const calls = [];
  const client = {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const step = script.shift();
          if (step === undefined) throw new Error("fake client: script exhausted");
          const handlers = {};
          return {
            on(event, fn) {
              (handlers[event] ??= []).push(fn);
              return this;
            },
            async finalMessage() {
              const msg = typeof step === "function" ? step(params) : step;
              if (msg?.beforeConnect instanceof Error) throw msg.beforeConnect;
              handlers.connect?.forEach((fn) => fn());
              if (msg instanceof Error) throw msg;
              for (const block of msg.content) {
                if (block.type === "text") handlers.text?.forEach((fn) => fn(block.text, block.text));
              }
              return msg;
            },
          };
        },
      },
    },
  };
  return client;
}
