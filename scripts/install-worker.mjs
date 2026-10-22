// Installs the built T3 Bridge.app on this Mac as an always-on worker: copies it to
// ~/Applications, offers the .dmg to other Macs from the control panel, and runs it hidden
// under launchd so it starts at login and restarts if it crashes.
//   node scripts/dist.mjs && node scripts/install-worker.mjs
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
const home = OS.homedir();
const label = "codes.t3.bridge";
const uid = process.getuid();
const builtApp = Path.join(root, "release", "mac-arm64", "T3 Bridge.app");
const installedApp = Path.join(home, "Applications", "T3 Bridge.app");
const plistPath = Path.join(home, "Library", "LaunchAgents", `${label}.plist`);
const downloads = Path.join(home, "Library", "Application Support", "T3 Bridge", "downloads");
const logFile = Path.join(home, "Library", "Logs", "T3 Bridge.log");

if (!FS.existsSync(builtApp)) throw new Error(`Build the app first: ${builtApp} is missing`);
const run = (command, args, options = {}) =>
  ChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });

run("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
// bootout returns before the old process has saved its state and exited; wait for it.
for (let waited = 0; waited < 20_000; waited += 500) {
  const listed = run("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" });
  if (listed.status !== 0) break;
  ChildProcess.execFileSync("sleep", ["0.5"]);
}
FS.mkdirSync(Path.dirname(installedApp), { recursive: true });
FS.rmSync(installedApp, { recursive: true, force: true });
run("ditto", [builtApp, installedApp]);

FS.mkdirSync(downloads, { recursive: true });
for (const name of FS.readdirSync(downloads))
  if (name.endsWith(".dmg")) FS.rmSync(Path.join(downloads, name));
for (const name of FS.readdirSync(Path.join(root, "release"))) {
  if (name.endsWith(".dmg"))
    FS.copyFileSync(Path.join(root, "release", name), Path.join(downloads, name));
}

const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
FS.mkdirSync(Path.dirname(plistPath), { recursive: true });
FS.mkdirSync(Path.dirname(logFile), { recursive: true });
FS.writeFileSync(
  plistPath,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(Path.join(installedApp, "Contents", "MacOS", "T3 Bridge"))}</string>
    <string>--hidden</string>
  </array>
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
  <key>StandardOutPath</key>
  <string>${escape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(logFile)}</string>
</dict>
</plist>
`,
);
const result = run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
if (result.status !== 0) throw new Error("launchctl bootstrap failed");
console.log(`T3 Bridge worker installed and started. Logs: ${logFile}`);
