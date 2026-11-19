import { spawn, execFile } from "node:child_process";

/** Command output beyond this is trimmed from the middle before Claude sees it. */
export const MAX_OUTPUT_CHARS = 40_000;
const MAX_BUFFER_CHARS = 2_000_000;

/** Keep the start and the end of long output (errors usually sit at one of the two). */
export function capOutput(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-tail)}`;
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // shell:true starts cmd.exe; kill it and everything it started.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Run a shell command and capture stdout+stderr interleaved.
 * Never rejects: failures are reported in the result.
 * @returns {Promise<{exitCode: number|null, timedOut: boolean, output: string, durationMs: number}>}
 */
export function runCommand(command, { cwd = process.cwd(), timeoutMs = 120_000, env = process.env } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd,
      env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onData = (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_BUFFER_CHARS) {
        output = output.slice(0, MAX_BUFFER_CHARS / 4) + "\n[...]\n" + output.slice(-MAX_BUFFER_CHARS / 2);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (exitCode, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        output: capOutput(output + extra),
        durationMs: Date.now() - started,
      });
    };

    child.on("error", (err) => finish(null, `\n[failed to start: ${err.message}]`));
    child.on("close", (code) => finish(code));
  });
}

/** Human/model-readable summary of a run. */
export function describeRun(command, run) {
  const status = run.timedOut
    ? "timed out"
    : run.exitCode === 0
      ? "succeeded (exit code 0)"
      : `failed (exit code ${run.exitCode})`;
  const body = run.output.trim() === "" ? "(no output)" : run.output;
  return `Command: ${command}\nResult: ${status} after ${(run.durationMs / 1000).toFixed(1)}s\n<command_output>\n${body}\n</command_output>`;
}

export function succeeded(run) {
  return run.exitCode === 0 && !run.timedOut;
}
