import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { debugSession, DEFAULT_MODEL, DEFAULT_EFFORT } from "./agent.js";
import { BackupStore, undoLastSession } from "./backup.js";
import { Workspace } from "./tools.js";
import { TerminalUI, color } from "./ui.js";
import { debugWithClaudeCode, ClaudeCodeError } from "./claude-code.js";

const HELP = `debugger — find and fix bugs with Claude

Usage:
  debugger fix "<command>"        Run the command; if it fails, find the root cause,
                                  fix it, and re-run to verify. You approve the changes.
  debugger diagnose "<command>"   Explain the root cause and suggest a fix. Changes nothing.
  debugger undo                   Restore every file changed by the last fix session.

Options:
  -p, --problem <text>   Describe the bug (useful when the command passes but behaves wrongly).
  -y, --yes              Approve every change and command without asking.
      --allow <command>  Also let Claude run this command (repeatable), e.g. --allow "npm run lint".
      --backend <name>   claude-code: use your Claude subscription through Claude Code
                         api: use an Anthropic API key (ANTHROPIC_API_KEY)
                         Default: api when ANTHROPIC_API_KEY is set, otherwise claude-code.
      --rounds <n>       Fix, re-run, fix again: at most n rounds (default 3).
      --max-turns <n>    Max Claude steps per round, api backend (default 40).
      --effort <level>   low | medium | high | xhigh | max (default ${DEFAULT_EFFORT}).
      --model <id>       Claude model (default ${DEFAULT_MODEL}).
      --timeout <secs>   Kill the command after this many seconds (default 120).
      --cwd <dir>        Project folder (default: current folder).
  -v, --verbose          Also show Claude's thinking summaries (api backend).
  -h, --help             Show this help.
      --version          Show the version.

Examples:
  debugger fix "npm test"
  debugger fix "python app.py" --problem "totals are off by one cent"
  debugger diagnose "node --test examples/buggy-calc"`;

const BACKENDS = new Set(["api", "claude-code"]);

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

class UsageError extends Error {}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive whole number.`);
  return n;
}

async function version() {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

function printSummary(ui, result, command) {
  const files = result.changedFiles;
  const filesLine = files.length ? `Changed: ${files.join(", ")}` : "";
  switch (result.status) {
    case "fixed":
      ui.success(result.initialRun.exitCode === 0 ? `Done. "${command}" still passes.` : `Fixed. "${command}" now passes.`);
      break;
    case "already_passing":
      ui.success(`"${command}" already passes. If something is still wrong, describe it with --problem "...".`);
      break;
    case "diagnosed":
      ui.success("Diagnosis complete (no files were changed).");
      break;
    case "still_failing":
      ui.error(`"${command}" still fails after ${result.rounds} round(s). See the output above.`);
      break;
    case "no_changes":
      ui.warn("Claude finished without changing any files. Its report above explains why.");
      break;
    case "refusal":
      ui.warn("Claude declined to continue with this request.");
      break;
    case "turn_limit":
      ui.warn("Stopped: hit the step limit for a round (raise it with --max-turns).");
      break;
    case "max_tokens":
      ui.warn("Stopped: a response hit the output limit mid-step.");
      break;
    case "reverted":
      ui.warn("All changes were reverted, so your files are as they were.");
      break;
    case "interrupted":
      ui.warn("Stopped at your request.");
      break;
    default:
      ui.warn(`Stopped (${result.status}).`);
  }
  if (filesLine) {
    ui.info(filesLine);
    ui.info(color.dim("Undo all of these changes with: debugger undo"));
  }
  const u = result.usage;
  if (u.requests) {
    ui.info(
      color.dim(
        `Tokens: ${u.input + u.cacheRead + u.cacheWrite} in (${u.cacheRead} from cache), ${u.output} out, over ${u.requests} request(s).`,
      ),
    );
  }
}

function reportApiError(ui, err) {
  if (err instanceof ClaudeCodeError) {
    ui.error(err.message);
  } else if (err instanceof Anthropic.AuthenticationError) {
    ui.error("Anthropic rejected the API key. Set a valid key in ANTHROPIC_API_KEY.");
  } else if (err instanceof Anthropic.PermissionDeniedError) {
    ui.error(`Your API key isn't allowed to do this: ${err.message}`);
  } else if (err instanceof Anthropic.NotFoundError) {
    ui.error(`Not found (is the --model id right?): ${err.message}`);
  } else if (err instanceof Anthropic.RateLimitError) {
    ui.error("Rate limited by the Anthropic API. Wait a minute and try again.");
  } else if (err instanceof Anthropic.BadRequestError) {
    ui.error(`The API rejected the request: ${err.message}`);
  } else if (err instanceof Anthropic.APIError) {
    ui.error(`Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}`);
  } else if (err instanceof Anthropic.AnthropicError) {
    ui.error(`${err.message}\nSet ANTHROPIC_API_KEY, or use your Claude subscription with --backend claude-code.`);
  } else {
    return false;
  }
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        problem: { type: "string", short: "p" },
        yes: { type: "boolean", short: "y" },
        allow: { type: "string", multiple: true },
        backend: { type: "string" },
        rounds: { type: "string" },
        "max-turns": { type: "string" },
        effort: { type: "string" },
        model: { type: "string" },
        timeout: { type: "string" },
        cwd: { type: "string" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) {
    console.log(await version());
    return 0;
  }
  const [sub, ...rest] = positionals;
  if (opts.help || !sub) {
    console.log(HELP);
    return opts.help ? 0 : 2;
  }

  const ui = new TerminalUI({ autoApprove: Boolean(opts.yes), verbose: Boolean(opts.verbose) });
  const root = path.resolve(opts.cwd ?? process.cwd());

  try {
    if (sub === "undo") {
      const restored = await undoLastSession(root);
      if (!restored) ui.warn("Nothing to undo in this folder.");
      else ui.success(`Restored ${restored.files.length} file(s) from the session for "${restored.command}": ${restored.files.map((f) => f.path).join(", ")}`);
      return 0;
    }
    if (sub !== "fix" && sub !== "diagnose") throw new UsageError(`Unknown command "${sub}".`);

    const command = rest.join(" ").trim();
    if (!command) throw new UsageError(`Tell me which command to ${sub}, e.g.: debugger ${sub} "npm test"`);
    const effort = opts.effort ?? DEFAULT_EFFORT;
    if (!EFFORTS.has(effort)) throw new UsageError(`--effort must be one of: ${[...EFFORTS].join(", ")}.`);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new UsageError(`Folder not found: ${root}`);

    const backend = opts.backend ?? (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");
    if (!BACKENDS.has(backend)) throw new UsageError(`--backend must be one of: ${[...BACKENDS].join(", ")}.`);

    const commandTimeoutMs = (opts.timeout ? positiveInt(opts.timeout, "timeout") : 120) * 1000;
    const backups = new BackupStore(root, { command });
    const common = {
      ui,
      command,
      problem: opts.problem,
      mode: sub,
      model: opts.model ?? DEFAULT_MODEL,
      effort,
      maxRounds: opts.rounds ? positiveInt(opts.rounds, "rounds") : 3,
      commandTimeoutMs,
    };
    if (backend === "claude-code") ui.info(color.dim("Using Claude Code (your Claude subscription)."));

    const result =
      backend === "claude-code"
        ? await debugWithClaudeCode({ ...common, root, backups, allowedCommands: opts.allow ?? [] })
        : await debugSession({
            ...common,
            client: new Anthropic(),
            workspace: await Workspace.create({
              root,
              ui,
              backups,
              targetCommand: command,
              allowedCommands: opts.allow ?? [],
              commandTimeoutMs,
            }),
            maxTurns: opts["max-turns"] ? positiveInt(opts["max-turns"], "max-turns") : 40,
          });
    printSummary(ui, result, command);
    return ["fixed", "already_passing", "diagnosed"].includes(result.status) ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      ui.error(err.message);
      return 2;
    }
    if (reportApiError(ui, err)) return 1;
    throw err;
  }
}

