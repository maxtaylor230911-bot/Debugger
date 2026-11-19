import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand, capOutput, describeRun, succeeded } from "../src/runner.js";

test("captures output and a zero exit code", async () => {
  const run = await runCommand(`node -e "console.log('hello'); console.error('oops')"`);
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  assert.match(run.output, /hello/);
  assert.match(run.output, /oops/);
  assert.ok(succeeded(run));
});

test("reports a failing exit code", async () => {
  const run = await runCommand(`node -e "process.exit(3)"`);
  assert.equal(run.exitCode, 3);
  assert.ok(!succeeded(run));
  assert.match(describeRun("x", run), /failed \(exit code 3\)/);
});

test("kills a command that runs too long", async () => {
  const run = await runCommand(`node -e "setTimeout(() => {}, 60000)"`, { timeoutMs: 500 });
  assert.equal(run.timedOut, true);
  assert.ok(!succeeded(run));
  assert.match(describeRun("x", run), /timed out/);
});

test("does not hang on commands that read stdin", async () => {
  const run = await runCommand(`node -e "process.stdin.on('data', () => {}).on('end', () => console.log('eof'))"`, {
    timeoutMs: 10_000,
  });
  assert.equal(run.timedOut, false);
  assert.match(run.output, /eof/);
});

test("capOutput keeps the start and end of long output", () => {
  const long = `START${"x".repeat(100_000)}END`;
  const capped = capOutput(long, 1000);
  assert.ok(capped.length < 1100);
  assert.ok(capped.startsWith("START"));
  assert.ok(capped.endsWith("END"));
  assert.match(capped, /characters omitted/);
  assert.equal(capOutput("short", 1000), "short");
});
