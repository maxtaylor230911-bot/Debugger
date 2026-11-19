import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { runApp, cleanPath } from "../src/app.js";
import { childEnv } from "../src/claude-code.js";
import { TerminalUI } from "../src/ui.js";
import { tempProject, cleanup } from "./helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

/** Run the interactive app with scripted keyboard input and a fake Claude. */
async function drive(lines, steps) {
  const downloads = await tempProject({});
  const statePath = path.join(downloads, "..", `${path.basename(downloads)}-state.json`);
  await fs.writeFile(statePath, JSON.stringify({ steps, calls: [] }));
  const input = new PassThrough();
  const out = { text: "", write(s) { this.text += s; } };
  const ui = new TerminalUI({ out, input, interactive: true });
  input.end(lines.map((l) => `${l}\n`).join(""));
  const code = await runApp({
    ui,
    downloads,
    pauseAtEnd: false,
    claude: {
      model: "claude-opus-5-5",
      effort: "high",
      claudeBin: process.execPath,
      claudePreArgs: [FAKE],
      env: { ...childEnv(), FAKE_CLAUDE_STATE: statePath },
    },
  });
  const calls = JSON.parse(await fs.readFile(statePath, "utf8")).calls;
  const done = async () => {
    await cleanup(downloads);
    await fs.rm(statePath, { force: true });
  };
  return { code, out: out.text, downloads, calls, done };
}

test("cleanPath strips the quotes Windows adds to dragged files", () => {
  assert.equal(cleanPath(`"C:\\My Code\\app.py"`), "C:\\My Code\\app.py");
  assert.equal(cleanPath(`& 'C:\\x\\y.js'`), "C:\\x\\y.js");
  assert.equal(cleanPath("  plain.txt  "), "plain.txt");
});

test("app: paste code, fix it, save to Downloads, report saved", async (t) => {
  const pasted = Array.from({ length: 3000 }, (_, i) => `line_${i} = ${i}`);
  pasted[1500] = "total = items[1:]  # bug";
  const fixedText = "fixed content\n";
  const r = await drive(
    [
      "2", // paste here
      ...pasted,
      "END",
      "py", // language
      "1", // fix mode
      "the total is wrong", // question
      "", // no follow-up
      "1", // save
      "n", // nothing else
    ],
    [{ edits: { "pasted-code.py": fixedText }, text: "Root cause: slice skips the first item." }],
  );
  t.after(r.done);

  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
  const [call] = r.calls;
  assert.match(call.prompt, /pasted-code\.py/);
  assert.match(call.prompt, /3000 lines/);
  assert.match(call.prompt, /the total is wrong/);
  assert.match(call.args[call.args.indexOf("--tools") + 1], /Edit/);
  assert.match(call.systemPrompt, /Read the whole file/);

  const files = await fs.readdir(r.downloads);
  const saved = files.find((f) => /^pasted-code-fixed-.*\.py$/.test(f));
  assert.ok(saved, `fixed file saved in Downloads (got ${files})`);
  assert.equal(await fs.readFile(path.join(r.downloads, saved), "utf8"), fixedText);

  const reports = await fs.readdir(path.join(r.downloads, "Debugger reports"));
  assert.equal(reports.length, 1);
  assert.match(await fs.readFile(path.join(r.downloads, "Debugger reports", reports[0]), "utf8"), /slice skips/);
});

test("app: inspect a dragged-in file and overwrite it, keeping a .bak", async (t) => {
  const project = await tempProject({ "my app.js": "const x = 1;\nconsole.log(x +);\n" });
  t.after(() => cleanup(project));
  const file = path.join(project, "my app.js");
  const r = await drive(
    [
      "1", // inspect a file
      `"${file}"`, // dragged path, with quotes
      "1", // fix
      "", // full review
      "what does line 2 do?", // follow-up
      "", // done
      "2", // overwrite
      "n",
    ],
    [
      { edits: { "my app.js": "const x = 1;\nconsole.log(x + 1);\n" }, text: "Syntax error on line 2." },
      { text: "It logs x + 1." },
    ],
  );
  t.after(r.done);

  assert.equal(await fs.readFile(file, "utf8"), "const x = 1;\nconsole.log(x + 1);\n");
  assert.equal(await fs.readFile(`${file}.bak`, "utf8"), "const x = 1;\nconsole.log(x +);\n");
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls[1].args.includes("--resume"), "follow-up continues the same conversation");
  const [report] = await fs.readdir(path.join(r.downloads, "Debugger reports"));
  const text = await fs.readFile(path.join(r.downloads, "Debugger reports", report), "utf8");
  assert.match(text, /Syntax error/);
  assert.match(text, /Follow-up: what does line 2 do\?/);
  assert.match(text, /It logs x \+ 1/);
});

test("app: review-only mode never offers to save and can't edit", async (t) => {
  const project = await tempProject({ "a.py": "print(1)\n" });
  t.after(() => cleanup(project));
  const r = await drive(["1", path.join(project, "a.py"), "2", "", "", "n"], [{ text: "Looks fine." }]);
  t.after(r.done);
  const [call] = r.calls;
  assert.doesNotMatch(call.args[call.args.indexOf("--tools") + 1], /Edit|Write/);
  assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "plan");
  assert.doesNotMatch(r.out, /Save the fixed code/);
  assert.equal(await fs.readFile(path.join(project, "a.py"), "utf8"), "print(1)\n");
});

test("app: missing files and binary files are refused clearly", async (t) => {
  const project = await tempProject({});
  await fs.writeFile(path.join(project, "x.bin"), Buffer.from([0, 1, 2, 0, 3]));
  t.after(() => cleanup(project));
  const r = await drive(["1", path.join(project, "nope.js"), "y", "1", path.join(project, "x.bin"), "n"], []);
  t.after(r.done);
  assert.match(r.out, /File not found/);
  assert.match(r.out, /binary file/);
  assert.equal(r.calls.length, 0);
});
