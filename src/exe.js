// Entry point for Debugger.exe. Double-clicked (no arguments) it opens the
// interactive menu; with arguments it behaves like the `debugger` command.
import { main } from "./main.js";
import { runApp } from "./app.js";

const args = process.argv.slice(2);
(async () => {
  try {
    process.exitCode = args.length ? await main(args) : await runApp();
  } catch (err) {
    console.error(`\nDebugger crashed: ${err?.stack ?? err}`);
    if (!args.length) {
      console.error("\nPress Enter to close this window.");
      process.stdin.once("data", () => process.exit(1));
    } else {
      process.exitCode = 1;
    }
  }
})();
