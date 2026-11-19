// Stand-in for `claude -p --output-format stream-json`, used by the tests.
// FAKE_CLAUDE_STATE names a JSON file: { steps: [...], calls: [...] }.
// Each run takes the next step, applies its file edits, prints stream-json,
// and records the arguments and prompt it was given.
import fs from "node:fs";
import path from "node:path";

const statePath = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const prompt = fs.readFileSync(0, "utf8");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

state.calls.push({
  args,
  prompt,
  settings: flag("--settings") ? JSON.parse(fs.readFileSync(flag("--settings"), "utf8")) : null,
  systemPrompt: flag("--append-system-prompt-file") ? fs.readFileSync(flag("--append-system-prompt-file"), "utf8") : null,
  sawJanOverride: Boolean(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL),
});
const step = state.steps[state.calls.length - 1] ?? { text: "nothing to do" };
fs.writeFileSync(statePath, JSON.stringify(state));

if (step.crash) {
  process.stderr.write("boom\n");
  process.exit(1);
}

const sessionId = flag("--resume") ?? "fake-session-1";
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
emit({ type: "system", subtype: "init", session_id: sessionId, model: flag("--model") });

const content = [];
for (const [file, text] of Object.entries(step.edits ?? {})) {
  const abs = path.join(process.cwd(), file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  content.push({ type: "tool_use", id: `tu_${file}`, name: "Edit", input: { file_path: abs } });
}
for (const file of step.delete ?? []) fs.rmSync(path.join(process.cwd(), file));
if (step.text) content.push({ type: "text", text: step.text });
emit({ type: "assistant", message: { content } });
emit({
  type: "result",
  subtype: step.isError ? "error_during_execution" : "success",
  is_error: Boolean(step.isError),
  result: step.text ?? "",
  session_id: sessionId,
  num_turns: 2,
  usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  permission_denials: (step.denied ?? []).map((command) => ({ tool_name: "Bash", tool_input: { command } })),
});
