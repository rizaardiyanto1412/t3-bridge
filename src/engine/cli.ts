/**
 * Runs the bridge engine without Electron, for development and tests:
 *   T3_BRIDGE_DATA=/tmp/bridge T3_BRIDGE_T3_URL=http://127.0.0.1:4791 \
 *   T3_BRIDGE_PAIR_COMMAND='node apps/server/src/bin.ts auth pairing create --base-dir /tmp/t3' \
 *   node dist-electron/cli.cjs
 */
import * as OS from "node:os";
import * as Path from "node:path";

import { ControlServer } from "./api/ControlServer.ts";
import { Engine } from "./Engine.ts";
import { FileSecretStore } from "./store.ts";

const dataDir =
  process.env.T3_BRIDGE_DATA ??
  Path.join(OS.homedir(), "Library", "Application Support", "T3 Bridge");
const pairCommand = process.env.T3_BRIDGE_PAIR_COMMAND?.split(" ").filter(Boolean);
const engine = new Engine({
  dataDir,
  secrets: new FileSecretStore(Path.join(dataDir, "secrets.json"), null),
  t3Defaults: {
    ...(process.env.T3_BRIDGE_T3_URL ? { httpBaseUrl: process.env.T3_BRIDGE_T3_URL } : {}),
    ...(pairCommand ? { pairCommand } : {}),
  },
  ...(process.env.T3_BRIDGE_PORT ? { controlPort: Number(process.env.T3_BRIDGE_PORT) } : {}),
});
const server = new ControlServer({
  engine,
  staticDir: process.env.T3_BRIDGE_STATIC ?? null,
  downloadsDir: null,
  updater: null,
});
void engine.start().then(async (config) => {
  await server.start(config.controlPort);
});

const shutdown = async () => {
  await server.stop();
  await engine.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
