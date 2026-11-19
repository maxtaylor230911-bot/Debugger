// Builds a standalone Debugger.exe (no Node.js install needed to run it):
//   1. bundle src/exe.js and its dependencies into one CommonJS file (esbuild)
//   2. turn it into a single executable with Node's --build-sea
//   3. copy it to the Downloads folder (skip with --no-copy)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const exeName = process.platform === "win32" ? "Debugger.exe" : "debugger";
await fs.mkdir(dist, { recursive: true });

const bundle = path.join(dist, "debugger-bundle.cjs");
await build({
  entryPoints: [path.join(root, "src", "exe.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundle,
  logLevel: "warning",
});

const configPath = path.join(dist, "sea-config.json");
const output = path.join(dist, exeName);
await fs.writeFile(
  configPath,
  JSON.stringify({ main: bundle, output, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2),
);
await fs.rm(output, { force: true });
execFileSync(process.execPath, ["--build-sea", configPath], { stdio: "inherit" });
console.log(`Built ${output}`);

if (!process.argv.includes("--no-copy")) {
  const target = path.join(os.homedir(), "Downloads", exeName);
  await fs.copyFile(output, target);
  console.log(`Copied to ${target}`);
}
