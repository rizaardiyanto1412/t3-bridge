// Pulls the latest T3 Bridge, rebuilds it and reinstalls the worker. The control panel's
// Update button starts this detached from the worker, because the last step replaces the
// worker that started it. Progress goes to update-status.json for the panel to show.
//   node scripts/update.mjs <status-file>
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
const statusFile = process.argv[2];
if (!statusFile) throw new Error("Usage: node scripts/update.mjs <status-file>");

const git = (...args) =>
  ChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const status = { state: "running", step: "", from: git("rev-parse", "--short", "HEAD"), to: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
const save = () => FS.writeFileSync(statusFile, JSON.stringify(status, null, 2));

function step(label, command, args) {
  status.step = label;
  save();
  console.log(`\n== ${label}: ${command} ${args.join(" ")}`);
  // Electron starts this script as Node; the tools it runs must not inherit that.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = ChildProcess.spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
}

try {
  step("Downloading the update", "git", ["pull", "--ff-only"]);
  status.to = git("rev-parse", "--short", "HEAD");
  step("Installing dependencies", "pnpm", ["install", "--frozen-lockfile"]);
  step("Building", "pnpm", ["dist"]);
  status.state = "restarting";
  status.step = "Restarting the worker";
  save();
  step("Restarting the worker", "node", ["scripts/install-worker.mjs"]);
  status.state = "done";
} catch (error) {
  status.state = "failed";
  status.error = error instanceof Error ? error.message : String(error);
} finally {
  status.finishedAt = new Date().toISOString();
  save();
}
