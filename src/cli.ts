import * as FS from "node:fs";
import * as Path from "node:path";
import { parseArgs } from "node:util";

import { ControlServer, tailnetAddresses } from "./engine/api/ControlServer.ts";
import { Engine } from "./engine/Engine.ts";
import * as Service from "./engine/service.ts";
import { FileSecretStore, readJson, writeJsonAtomic, type BridgeConfig } from "./engine/store.ts";
import { Updater, type UpdateStatus } from "./engine/updater.ts";
import { BRIDGE_VERSION } from "./engine/version.ts";

const HELP = `T3 Bridge ${BRIDGE_VERSION}: chat with a T3 Code thread from Slack, Discord or Telegram.

Usage: npx t3-bridge [command]

  run          Run in this terminal (the default)
  install      Run in the background on this Mac, starting at login
  uninstall    Stop the background service; bots and settings are kept
  link         Print the control panel link
  status       Show whether T3 Code and the bots are connected
`;

// Overrides for development against an isolated T3 server; see README.
const dataDir = process.env.T3_BRIDGE_DATA ?? Service.dataDir;
const packageDir = __dirname;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    service: { type: "boolean" },
    "status-file": { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

function fileLogSink(echo: boolean) {
  const file = process.env.T3_BRIDGE_DATA ? Path.join(dataDir, "bridge.log") : Service.logFile;
  FS.mkdirSync(Path.dirname(file), { recursive: true });
  return (line: string) => {
    if (echo) console.log(line);
    try {
      FS.appendFileSync(file, `${line}\n`);
      if (FS.statSync(file).size > 5 * 1024 * 1024) FS.renameSync(file, `${file}.1`);
    } catch {
      // Logging must never take the bridge down.
    }
  };
}

async function readConfig() {
  return readJson<BridgeConfig>(Path.join(dataDir, "config.json"));
}

function links(config: Pick<BridgeConfig, "controlPort" | "controlToken">) {
  const hosts = [...tailnetAddresses(), "127.0.0.1"];
  return hosts.map((host) => `http://${host}:${config.controlPort}/#token=${config.controlToken}`);
}

function printLinks(config: Pick<BridgeConfig, "controlPort" | "controlToken">) {
  const [first, ...rest] = links(config);
  console.log(`\nControl panel (keep this link private, it works like a password):\n  ${first}`);
  for (const link of rest) console.log(`  ${link}`);
  if (tailnetAddresses().length === 0) {
    console.log("\nTo open it from other devices, install Tailscale on this Mac and run `npx t3-bridge link`.");
  }
}

async function run() {
  const pairCommand = process.env.T3_BRIDGE_PAIR_COMMAND?.split(" ").filter(Boolean);
  const engine = new Engine({
    dataDir,
    secrets: new FileSecretStore(Path.join(dataDir, "secrets.json"), null),
    logSink: fileLogSink(!flags.service),
    t3Defaults: {
      ...(process.env.T3_BRIDGE_T3_URL ? { httpBaseUrl: process.env.T3_BRIDGE_T3_URL } : {}),
      ...(pairCommand ? { pairCommand } : {}),
    },
    ...(process.env.T3_BRIDGE_PORT ? { controlPort: Number(process.env.T3_BRIDGE_PORT) } : {}),
  });
  const server = new ControlServer({
    engine,
    staticDir: process.env.T3_BRIDGE_STATIC ?? Path.join(packageDir, "panel"),
    updater: new Updater(dataDir),
  });
  const config = await engine.start();
  await server.start(config.controlPort);
  if (!flags.service) {
    printLinks(config);
    if (!Service.isInstalled()) console.log("\nTo keep it running after you close this terminal: npx t3-bridge install");
  }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    // Saving bot state is async; exit only once it is on disk so nothing is posted twice.
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function install() {
  const statusFile = flags["status-file"];
  const progress = async (patch: Partial<UpdateStatus>) => {
    if (statusFile === undefined) return;
    const current = await readJson<UpdateStatus>(statusFile);
    if (current !== null) await writeJsonAtomic(statusFile, { ...current, ...patch });
  };
  try {
    await progress({ state: "restarting", step: "Restarting T3 Bridge" });
    Service.install(packageDir);
  } catch (error) {
    await progress({ state: "failed", error: String(error), finishedAt: new Date().toISOString() });
    throw error;
  }
  const config = await waitForPanel();
  await progress({ state: "done", step: "Done", finishedAt: new Date().toISOString() });
  console.log(`T3 Bridge ${BRIDGE_VERSION} is running in the background and starts at login.`);
  console.log(`Logs: ${Service.logFile}`);
  if (config !== null) printLinks(config);
}

/** Waits for the freshly started service to answer, so the printed link works when opened. */
async function waitForPanel() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const config = await readConfig();
    if (config !== null) {
      const ok = await fetch(`http://127.0.0.1:${config.controlPort}/api/status`, {
        headers: { authorization: `Bearer ${config.controlToken}` },
      }).then((response) => response.ok, () => false);
      if (ok) return config;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log("T3 Bridge did not answer within 30 seconds. Check the log:", Service.logFile);
  return readConfig();
}

async function status() {
  const config = await readConfig();
  if (config === null) return void console.log("T3 Bridge has not been set up on this Mac yet. Run: npx t3-bridge install");
  const response = await fetch(`http://127.0.0.1:${config.controlPort}/api/status`, {
    headers: { authorization: `Bearer ${config.controlToken}` },
  }).catch(() => null);
  if (response === null || !response.ok) {
    console.log(`T3 Bridge is not running.${Service.isInstalled() ? ` See ${Service.logFile}` : " Start it with: npx t3-bridge install"}`);
    process.exitCode = 1;
    return;
  }
  const body = (await response.json()) as {
    version: string;
    t3: { state: string; label: string; error?: string };
    bots: Array<{ name: string; connection: { state: string; error?: string } }>;
  };
  console.log(`T3 Bridge ${body.version}${Service.isInstalled() ? " (background service)" : ""}`);
  console.log(`T3 Code: ${body.t3.state}${body.t3.error ? ` (${body.t3.error})` : ""}`);
  for (const bot of body.bots) {
    console.log(`${bot.name}: ${bot.connection.state}${bot.connection.error ? ` (${bot.connection.error})` : ""}`);
  }
  if (body.bots.length === 0) console.log("No bots yet. Add one in the control panel.");
}

async function main() {
  const command = positionals[0] ?? "run";
  if (flags.version) return void console.log(BRIDGE_VERSION);
  if (flags.help || command === "help") return void console.log(HELP);
  switch (command) {
    case "run":
      return run();
    case "install":
      return install();
    case "uninstall":
      Service.uninstall();
      return void console.log(`T3 Bridge stopped and removed from login. Your bots and settings stay in ${dataDir}.`);
    case "link": {
      const config = await readConfig();
      if (config === null) return void console.log("T3 Bridge has not been set up on this Mac yet. Run: npx t3-bridge install");
      return printLinks(config);
    }
    case "status":
      return status();
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
