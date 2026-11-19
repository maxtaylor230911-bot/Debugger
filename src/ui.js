import readline from "node:readline/promises";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const color = {
  dim: paint("2"),
  bold: paint("1"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  cyan: paint("36"),
};

/** Terminal UI. `autoApprove` answers yes to every prompt (--yes). */
export class TerminalUI {
  constructor({ autoApprove = false, verbose = false, out = process.stdout, input = process.stdin, interactive } = {}) {
    this.autoApprove = autoApprove;
    this.verbose = verbose;
    this.out = out;
    this.input = input;
    this.interactive = interactive ?? Boolean(input.isTTY);
    this.midLine = false;
  }

  write(s) {
    this.out.write(s);
    this.midLine = !s.endsWith("\n");
  }

  #line(s) {
    if (this.midLine) this.write("\n");
    this.write(`${s}\n`);
  }

  info(s) { this.#line(s); }
  step(s) { this.#line(color.cyan(`▸ ${s}`)); }
  success(s) { this.#line(color.green(`✔ ${s}`)); }
  warn(s) { this.#line(color.yellow(`! ${s}`)); }
  error(s) { this.#line(color.red(`✖ ${s}`)); }

  /** Streaming model text. */
  text(delta) { this.write(delta); }

  /** Streaming thinking summary (only with --verbose). */
  thinking(delta) {
    if (this.verbose) this.write(color.dim(delta));
  }

  tool(name, summary) { this.#line(color.dim(`  → ${name} ${summary}`)); }

  diff(lines) {
    for (const l of lines) {
      if (l.startsWith("+")) this.#line(color.green(l));
      else if (l.startsWith("-")) this.#line(color.red(l));
      else this.#line(color.dim(l));
    }
  }

  /**
   * Ask a yes/no question. Returns {approved, feedback}. Without a terminal
   * (and without --yes) everything is declined, so unattended runs are safe.
   */
  async confirm(question) {
    if (this.autoApprove) return { approved: true };
    if (!this.interactive) {
      this.warn(`${question} — declined (no terminal; pass --yes to allow)`);
      return { approved: false, feedback: "Declined automatically: not running in an interactive terminal." };
    }
    const answer = ((await this.ask(`${question} [y/N, or type why not] `)) ?? "").trim();
    if (/^(y|yes)$/i.test(answer)) return { approved: true };
    return { approved: false, feedback: answer && !/^(n|no)$/i.test(answer) ? answer : undefined };
  }

  // One shared line reader for every question, so menus, pasted blocks and
  // confirmations never compete for stdin. Lines that arrive before they're
  // asked for (a fast paste, piped input) are queued, not lost.
  #rl = null;
  #queue = [];
  #waiters = [];
  #closed = false;

  #reader() {
    if (this.#rl) return;
    const terminal = Boolean(this.input.isTTY);
    this.#rl = readline.createInterface({ input: this.input, output: terminal ? this.out : undefined, terminal });
    this.#rl.on("line", (line) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
      else this.#queue.push(line);
    });
    this.#rl.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
    // In raw mode Ctrl+C reaches readline, not the process: pass it on.
    this.#rl.on("SIGINT", () => {
      if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT");
      else {
        this.write("\n");
        process.exit(130);
      }
    });
  }

  /** Next line of input, or null once input has ended. */
  nextLine() {
    this.#reader();
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Show a prompt and read one line (null if input ended). */
  async ask(question) {
    if (this.midLine) this.write("\n");
    this.write(color.bold(question));
    this.midLine = false;
    return this.nextLine();
  }

  /** Read lines until one equals `endToken` (or input ends). No length limit. */
  async readBlock(endToken = "END") {
    const lines = [];
    for (;;) {
      const line = await this.nextLine();
      if (line === null || line.trim() === endToken) break;
      lines.push(line);
    }
    return lines.join("\n");
  }

  close() {
    this.#rl?.close();
  }
}
