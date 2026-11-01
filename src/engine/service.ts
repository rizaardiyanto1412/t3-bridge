import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const LABEL = "codes.t3.bridge";
const UNIT = "t3-bridge.service";

export interface ServicePaths {
  readonly dataDir: string;
  readonly logFile: string;
}

/** macOS keeps the Library layout; Linux follows the XDG base directories. */
export function pathsFor(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): ServicePaths {
  if (platform === "linux") {
    const data = env.XDG_DATA_HOME || Path.join(home, ".local", "share");
    const state = env.XDG_STATE_HOME || Path.join(home, ".local", "state");
    return {
      dataDir: Path.join(data, "t3-bridge"),
      logFile: Path.join(state, "t3-bridge", "bridge.log"),
    };
  }
  return {
    dataDir: Path.join(home, "Library", "Application Support", "T3 Bridge"),
    logFile: Path.join(home, "Library", "Logs", "T3 Bridge.log"),
  };
}

/**
 * Before 0.6, Linux used the macOS layout for `npx t3-bridge` in a terminal. Moves those bots
 * and settings to the XDG location once, so upgrading keeps them.
 */
export function moveLegacyData(platform: NodeJS.Platform, home: string, to: string) {
  if (platform !== "linux") return;
  const from = pathsFor("darwin", home, {}).dataDir;
  if (!FS.existsSync(from) || FS.existsSync(to)) return;
  FS.mkdirSync(Path.dirname(to), { recursive: true });
  FS.renameSync(from, to);
}

const paths = pathsFor(process.platform, OS.homedir(), process.env);
export const dataDir = paths.dataDir;
export const logFile = paths.logFile;
/** The copy the service runs. npx keeps its packages in a cache it may clear, so the service never runs from there. */
export const runtimeDir = Path.join(dataDir, "runtime");
const serviceLog = Path.join(dataDir, "service.log");
const entry = () => Path.join(runtimeDir, "cli.cjs");

/** What install, status and uninstall need from the OS service manager. */
interface Supervisor {
  readonly file: string;
  isRunning(): boolean;
  /** Stops the service and waits until the old process has exited. */
  stop(): void;
  /** Writes the service definition and starts it. */
  register(): void;
  /** Removes the service from startup; the definition file is deleted afterwards. */
  unregister(): void;
}

/**
 * The PATH the service gets, so it finds `node`, `npx` and T3's CLI after Node is upgraded.
 * npx puts its temporary package bins first; those vanish when its cache is cleared.
 */
function servicePath() {
  const entries = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry !== "" && !entry.includes("_npx") && !entry.includes("node_modules"));
  return [...new Set([...entries, Path.dirname(process.execPath), "/usr/bin", "/bin"])].join(":");
}

const plistPath = Path.join(OS.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 0}`;
const launchctl = (...args: string[]) =>
  ChildProcess.spawnSync("launchctl", args, { encoding: "utf8" });
const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const launchd: Supervisor = {
  file: plistPath,
  isRunning: () => launchctl("print", `${domain()}/${LABEL}`).status === 0,
  stop() {
    launchctl("bootout", `${domain()}/${LABEL}`);
    // bootout returns before the old process has saved its state and exited; wait for it.
    for (let waited = 0; waited < 20_000 && launchd.isRunning(); waited += 250) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  },
  register() {
    FS.mkdirSync(Path.dirname(plistPath), { recursive: true });
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
    <string>${escapeXml(entry())}</string>
    <string>run</string>
    <string>--service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(servicePath())}</string>
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
  <string>${escapeXml(serviceLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(serviceLog)}</string>
</dict>
</plist>
`,
    );
    const result = launchctl("bootstrap", domain(), plistPath);
    if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
  },
  unregister: () => launchd.stop(),
};

const unitPath = Path.join(
  process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config"),
  "systemd",
  "user",
  UNIT,
);

/** Quotes one word of a unit file line; `%` starts a specifier there, so it is doubled. */
const unitWord = (value: string) => `"${value.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;

export function systemdUnit(input: {
  readonly entry: string;
  readonly path: string;
  readonly serviceLog: string;
}) {
  return `[Unit]
Description=T3 Bridge
After=network.target

[Service]
ExecStart=/usr/bin/env node ${unitWord(input.entry)} run --service
Environment=${unitWord(`PATH=${input.path}`)}
Restart=on-failure
RestartSec=10
# An update reinstalls this unit; the updater it starts must outlive the old process.
KillMode=process
# The bridge writes its own rotated log; this only catches crashes before it starts.
StandardOutput=append:${input.serviceLog.replace(/%/g, "%%")}
StandardError=append:${input.serviceLog.replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
}

/**
 * systemctl --user finds the user's manager through XDG_RUNTIME_DIR, which `sudo -u` and
 * some SSH setups leave unset. Lingering users always have one at /run/user/<uid>.
 */
function userManagerEnv() {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && process.getuid) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return env;
}

const systemctl = (...args: string[]) =>
  ChildProcess.spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: userManagerEnv() });

function ensureLinger() {
  const user = OS.userInfo().username;
  const shown = ChildProcess.spawnSync("loginctl", ["show-user", user, "--property=Linger", "--value"], {
    encoding: "utf8",
  });
  if (shown.stdout.trim() === "yes") return;
  const enabled = ChildProcess.spawnSync("loginctl", ["enable-linger", user], { encoding: "utf8" });
  if (enabled.status !== 0) {
    console.warn(
      `T3 Bridge runs while you are logged in, but could not start at boot: ${enabled.stderr.trim()}\n` +
        `Run this once to fix it: sudo loginctl enable-linger ${user}`,
    );
  }
}

const systemd: Supervisor = {
  file: unitPath,
  isRunning: () => systemctl("is-active", "--quiet", UNIT).status === 0,
  // systemctl stop waits for the process to exit.
  stop: () => void systemctl("stop", UNIT),
  register() {
    FS.mkdirSync(Path.dirname(unitPath), { recursive: true });
    FS.writeFileSync(
      unitPath,
      systemdUnit({ entry: entry(), path: servicePath(), serviceLog }),
    );
    // Without lingering, systemd stops user services at logout and starts them only at login.
    ensureLinger();
    for (const args of [["daemon-reload"], ["enable", UNIT], ["restart", UNIT]]) {
      const result = systemctl(...args);
      if (result.status !== 0) {
        throw new Error(`systemctl --user ${args.join(" ")} failed: ${result.stderr.trim()}`);
      }
    }
  },
  unregister() {
    systemctl("disable", "--now", UNIT);
    FS.rmSync(unitPath, { force: true });
    systemctl("daemon-reload");
  },
};

function supervisor(): Supervisor {
  if (process.platform === "darwin") return launchd;
  if (process.platform === "linux") return systemd;
  throw new Error(
    "Running in the background is set up for macOS and Linux only. Use `npx t3-bridge` under your own supervisor.",
  );
}

export function isInstalled() {
  return process.platform === "darwin" || process.platform === "linux"
    ? FS.existsSync(supervisor().file)
    : false;
}

export function isRunning() {
  return supervisor().isRunning();
}

/** Copies this build into the runtime directory and runs it in the background, starting with the machine. */
export function install(packageDir: string) {
  const service = supervisor();
  service.stop();
  const staging = `${runtimeDir}.new`;
  FS.rmSync(staging, { recursive: true, force: true });
  FS.cpSync(packageDir, staging, { recursive: true, filter: (source) => !source.endsWith(".map") });
  FS.rmSync(runtimeDir, { recursive: true, force: true });
  FS.renameSync(staging, runtimeDir);
  FS.mkdirSync(Path.dirname(logFile), { recursive: true });
  service.register();
}

/** Stops the service and removes it from startup. Bots, tokens and the link stay in the data directory. */
export function uninstall() {
  const service = supervisor();
  service.unregister();
  FS.rmSync(service.file, { force: true });
  FS.rmSync(runtimeDir, { recursive: true, force: true });
}

/** How the service starts, for messages. */
export const startsWith = process.platform === "linux" ? "boot" : "login";
