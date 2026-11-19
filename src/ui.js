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
  constructor({ autoApprove = false, verbose = false, out = process.stdout, input = process.stdin } = {}) {
    this.autoApprove = autoApprove;
    this.verbose = verbose;
    this.out = out;
    this.input = input;
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
    if (!this.input.isTTY) {
      this.warn(`${question} — declined (no terminal; pass --yes to allow)`);
      return { approved: false, feedback: "Declined automatically: not running in an interactive terminal." };
    }
    const rl = readline.createInterface({ input: this.input, output: this.out });
    try {
      if (this.midLine) this.write("\n");
      const answer = (await rl.question(color.bold(`${question} [y/N, or type why not] `))).trim();
      this.midLine = false;
      if (/^(y|yes)$/i.test(answer)) return { approved: true };
      return { approved: false, feedback: answer && !/^(n|no)$/i.test(answer) ? answer : undefined };
    } finally {
      rl.close();
    }
  }
}
