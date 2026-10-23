import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const LABEL = "codes.t3.bridge";

export const dataDir = Path.join(OS.homedir(), "Library", "Application Support", "T3 Bridge");
export const logFile = Path.join(OS.homedir(), "Library", "Logs", "T3 Bridge.log");
/** The copy launchd runs. npx keeps its packages in a cache it may clear, so the service never runs from there. */
export const runtimeDir = Path.join(dataDir, "runtime");
const plistPath = Path.join(OS.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 0}`;

const launchctl = (...args: string[]) =>
  ChildProcess.spawnSync("launchctl", args, { encoding: "utf8" });

export function isInstalled() {
  return FS.existsSync(plistPath);
}

export function isRunning() {
  return launchctl("print", `${domain()}/${LABEL}`).status === 0;
}

function stop() {
  launchctl("bootout", `${domain()}/${LABEL}`);
  // bootout returns before the old process has saved its state and exited; wait for it.
  for (let waited = 0; waited < 20_000 && isRunning(); waited += 250) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

/**
 * The PATH the service gets, so it finds `node`, `npx` and T3's CLI after Homebrew upgrades
 * Node. npx puts its temporary package bins first; those vanish when its cache is cleared.
 */
function servicePath() {
  const entries = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry !== "" && !entry.includes("_npx") && !entry.includes("node_modules"));
  return [...new Set([...entries, Path.dirname(process.execPath), "/usr/bin", "/bin"])].join(":");
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Copies this build into the runtime directory and runs it at login under launchd. */
export function install(packageDir: string) {
  if (process.platform !== "darwin") {
    throw new Error("Running in the background is only set up for macOS. Use `npx t3-bridge` under your own supervisor.");
  }
  stop();
  const staging = `${runtimeDir}.new`;
  FS.rmSync(staging, { recursive: true, force: true });
  FS.cpSync(packageDir, staging, { recursive: true, filter: (source) => !source.endsWith(".map") });
  FS.rmSync(runtimeDir, { recursive: true, force: true });
  FS.renameSync(staging, runtimeDir);

  FS.mkdirSync(Path.dirname(plistPath), { recursive: true });
  FS.mkdirSync(Path.dirname(logFile), { recursive: true });
  FS.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${escape(Path.join(runtimeDir, "cli.cjs"))}</string>
    <string>run</string>
    <string>--service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(servicePath())}</string>
  </dict>
  <!-- An update reinstalls this job; the updater it starts must outlive the old process. -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <!-- The bridge writes its own rotated log; this only catches crashes before it starts. -->
  <key>StandardOutPath</key>
  <string>${escape(Path.join(dataDir, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(Path.join(dataDir, "service.log"))}</string>
</dict>
</plist>
`,
  );
  const result = launchctl("bootstrap", domain(), plistPath);
  if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
}

/** Stops the service and removes it from login. Bots, tokens and the link stay in the data directory. */
export function uninstall() {
  stop();
  FS.rmSync(plistPath, { force: true });
  FS.rmSync(runtimeDir, { recursive: true, force: true });
}
