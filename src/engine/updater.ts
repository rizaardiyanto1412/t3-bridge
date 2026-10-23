import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import { BRIDGE_VERSION } from "./version.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export interface UpdateCheck {
  readonly available: boolean;
  readonly current: string;
  readonly latest: string | null;
  readonly reason: string | null;
}

export interface UpdateStatus {
  readonly state: "running" | "restarting" | "done" | "failed";
  readonly step: string;
  readonly from: string;
  readonly to: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

const REGISTRY = "https://registry.npmjs.org/t3-bridge/latest";

export function newerThan(candidate: string, current: string) {
  const parse = (version: string) => version.split("-")[0]!.split(".").map(Number);
  const [a, b] = [parse(candidate), parse(current)];
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Updates the background service to the newest t3-bridge on npm by running
 * `npx t3-bridge@<version> install`, which replaces and restarts this process.
 */
export class Updater {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  get statusFile() {
    return Path.join(this.dataDir, "update-status.json");
  }

  async check(): Promise<UpdateCheck> {
    const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`npm answered ${response.status}`);
    const latest = ((await response.json()) as { version?: string }).version ?? null;
    return {
      available: latest !== null && newerThan(latest, BRIDGE_VERSION),
      current: BRIDGE_VERSION,
      latest,
      reason: null,
    };
  }

  status(): Promise<UpdateStatus | null> {
    return readJson<UpdateStatus>(this.statusFile);
  }

  async start(): Promise<void> {
    const previous = await this.status();
    const recent = previous !== null && Date.now() - Date.parse(previous.startedAt) < 30 * 60_000;
    if (recent && (previous.state === "running" || previous.state === "restarting")) {
      throw new Error("An update is already running.");
    }
    const { latest, available } = await this.check();
    if (!available || latest === null) throw new Error("T3 Bridge is already up to date.");
    const status: UpdateStatus = {
      state: "running",
      step: `Downloading T3 Bridge ${latest}`,
      from: BRIDGE_VERSION,
      to: latest,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    await writeJsonAtomic(this.statusFile, status);
    const log = FS.openSync(Path.join(this.dataDir, "update.log"), "w");
    // Detached in its own process group, because installing the new version ends this process.
    const child = ChildProcess.spawn(
      "npx",
      ["--yes", `t3-bridge@${latest}`, "install", "--status-file", this.statusFile],
      { detached: true, stdio: ["ignore", log, log] },
    );
    child.once("exit", (code) => {
      // Reached only if the install never got as far as replacing this process.
      if (code !== 0) {
        void writeJsonAtomic(this.statusFile, {
          ...status,
          state: "failed",
          error: `npx exited with ${code}; see update.log in ${this.dataDir}`,
          finishedAt: new Date().toISOString(),
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new Error(`Could not start npx: ${error.message}`)));
    });
    child.unref();
  }
}
