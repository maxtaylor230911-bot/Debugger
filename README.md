# Debugger

Point it at a failing command. Claude reads the error, finds the root cause in your code,
fixes it (you approve every change), and then **re-runs the command to prove the fix works**.

```
debugger fix "npm test"
```

What a session looks like (illustrative, abridged):

```
▸ Running: npm test
It fails. Handing it to Claude...

  → read_file src/stats.js
  → search /median/ in *.js
▸ Proposed edit to src/stats.js
-   const sorted = numbers.sort();
+   const sorted = [...numbers].sort((a, b) => a - b);
Apply this edit to src/stats.js? [y/N, or type why not] y
...
▸ Re-running to verify: npm test
✔ Fixed. "npm test" now passes.
Changed: src/stats.js
Undo all of these changes with: debugger undo
```

It works with any language: anything you can run from a terminal (`pytest`, `cargo test`,
`python app.py`, `go build ./...`) can be debugged.

## Setup

You need [Node.js](https://nodejs.org) 22 or newer and an Anthropic API key from
[console.anthropic.com](https://console.anthropic.com/).

```bash
git clone https://github.com/maxtaylor230911-bot/Debugger.git
cd Debugger
npm install
npm link            # makes the `debugger` command available everywhere
```

Set your key (PowerShell shown; on macOS/Linux use `export ANTHROPIC_API_KEY=...`):

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

### Try it on the included buggy example

```bash
npm run demo
```

That runs `debugger fix "node --test examples/buggy-calc"`. The example has three real bugs
(an off-by-one, an alphabetical sort of numbers, and an input that gets modified). Afterwards,
`debugger undo` puts the bugs back so you can try again.

## Commands

| Command | What it does |
| --- | --- |
| `debugger fix "<command>"` | Runs the command. If it fails, Claude investigates, proposes edits for your approval, and the command is re-run to verify. If it still fails, Claude gets the new output and keeps going (up to 3 rounds). |
| `debugger diagnose "<command>"` | Same investigation, but read-only: you get the root cause and a suggested diff, and no files are changed. |
| `debugger undo` | Restores every file changed by the last `fix` session (and deletes files it created). |

### Options

| Option | Meaning |
| --- | --- |
| `-p, --problem "<text>"` | Describe the bug in your own words. Use this when the command passes but the behaviour is wrong (`debugger fix "python app.py" -p "the total is off by one cent"`). |
| `-y, --yes` | Approve every edit and command automatically. Handy in CI; review the changes afterwards. |
| `--rounds <n>` | Maximum fix → re-run rounds (default 3). |
| `--max-turns <n>` | Maximum Claude steps per round (default 40). |
| `--effort <level>` | `low`, `medium`, `high` (default), `xhigh` or `max`. Higher means more thorough but slower, with more tokens. |
| `--model <id>` | Claude model (default `claude-opus-5-5`). |
| `--timeout <secs>` | Kill the command if it runs longer than this (default 120). |
| `--cwd <dir>` | Project folder (default: the current folder). |
| `-v, --verbose` | Also show summaries of Claude's reasoning. |

## How it works

1. **Reproduce.** Debugger runs your command and captures the exit code and output.
2. **Investigate.** Claude (Opus 5.5 with adaptive thinking) gets the failure and a small set of
   tools: `list_files`, `read_file`, `search`, `run_command`, `edit_file` and `write_file`. It
   reads the stack trace, opens the code, follows the data back to the root cause, and can re-run
   narrower commands (one test, one input) to check its ideas.
3. **Fix, with your approval.** Every edit is shown as a diff and needs your **y**. Answer with a
   reason instead ("don't touch the tests") and Claude adapts. Any command other than the one
   you're debugging also needs approval.
4. **Verify.** Debugger re-runs your command itself. It doesn't take Claude's word for it. If the
   command still fails, the new output goes back to Claude for another round.
5. **Report.** Claude ends with the root cause, what changed, and what was verified.

### Safety

- Claude can only read and write files **inside the project folder**, and never inside `.git/`.
- The original of every file is saved in `.debugger/` before it's changed, so `debugger undo` can
  roll back a whole session.
- Without a terminal (for example in a script) and without `--yes`, every change is declined.
- Commands run with no input (stdin is closed) and are killed after the timeout.
- File contents and command output are treated as data, not instructions.
- Claude is told never to "fix" a failure by weakening or deleting tests or hiding errors.

### Cost

Each request is billed to your Anthropic API key. Prompt caching is on, so repeated context in a
session is much cheaper. A token summary is printed at the end of every run. Use
`--effort medium` for quicker, cheaper runs on simple bugs.

## Development

```bash
npm test
```

The test suite needs no API key. It uses a scripted fake Claude, plus one test that drives the
real Anthropic SDK against a local mock server. CI runs it on Linux and Windows
([`.github/workflows/test.yml`](.github/workflows/test.yml)).

| Path | What's in it |
| --- | --- |
| `src/cli.js`, `src/main.js` | Command-line parsing and the summary output |
| `src/agent.js` | The investigate → fix → verify loop and the Claude API calls |
| `src/tools.js` | The tools Claude uses, with path confinement, approvals and diffs |
| `src/runner.js` | Runs commands with a timeout and captures output |
| `src/backup.js` | Backups and `debugger undo` |
| `examples/buggy-calc/` | A small buggy project to try it on |
| `test/` | Tests |

## Security scanning with 0security

This repo also runs [0security](https://github.com/0sec-labs/0security), an open-source AI
security agent, on every pull request ([`.github/workflows/0security.yml`](.github/workflows/0security.yml)),
using the instructions in [`.0security/scan-prompt.md`](.0security/scan-prompt.md). To turn it on,
add an `ANTHROPIC_API_KEY` repository secret under **Settings → Secrets and variables → Actions**.
Without it, the scan is skipped with a notice. The `app/` folder is a deliberately vulnerable demo
for that scan. **Don't deploy it.**

## License

MIT. 0security is MIT OR Apache-2.0 and is used unmodified, as a Docker image.
