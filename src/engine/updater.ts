import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import { readJson } from "./store.ts";

export interface UpdateCheck {
  readonly available: boolean;
  readonly current: string | null;
  readonly latest: string | null;
  readonly changes: ReadonlyArray<string>;
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

/**
 * Updates a worker from the git checkout it was installed from (install-worker records it in
 * T3_BRIDGE_SOURCE). Without one, e.g. an app opened from the .dmg, there is nothing to update.
 */
export class Updater {
  private readonly source: string | null;
  private readonly dataDir: string;

  constructor(dataDir: string, source = process.env.T3_BRIDGE_SOURCE ?? null) {
    this.dataDir = dataDir;
    this.source = source;
  }

  private get statusFile() {
    return Path.join(this.dataDir, "update-status.json");
  }

  private git(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) =>
      ChildProcess.execFile("git", args, { cwd: this.source!, timeout: 60_000 }, (error, stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()),
      ),
    );
  }

  async current(): Promise<string | null> {
    if (this.source === null) return null;
    return this.git("log", "-1", "--format=%h · %cs").catch(() => null);
  }

  async check(): Promise<UpdateCheck> {
    if (this.source === null) {
      return { available: false, current: null, latest: null, changes: [], reason: "This worker was not installed from a git checkout, so it cannot update itself." };
    }
    await this.git("fetch", "--quiet", "origin");
    const upstream = await this.git("rev-parse", "--abbrev-ref", "@{upstream}");
    const changes = (await this.git("log", "--format=%s", `HEAD..${upstream}`)).split("\n").filter(Boolean);
    const dirty = (await this.git("status", "--porcelain", "--untracked-files=no")).length > 0;
    return {
      available: changes.length > 0 && !dirty,
      current: await this.current(),
      latest: await this.git("log", "-1", "--format=%h · %cs", upstream),
      changes,
      reason: dirty ? `The checkout at ${this.source} has local changes; commit or discard them first.` : null,
    };
  }

  status(): Promise<UpdateStatus | null> {
    return readJson<UpdateStatus>(this.statusFile);
  }

  async start(): Promise<void> {
    if (this.source === null) throw new Error("This worker was not installed from a git checkout.");
    const previous = await this.status();
    const recent = previous !== null && Date.now() - Date.parse(previous.startedAt) < 30 * 60_000;
    if (recent && (previous.state === "running" || previous.state === "restarting")) {
      throw new Error("An update is already running.");
    }
    const log = FS.openSync(Path.join(this.dataDir, "update.log"), "w");
    // Run by the system's Node, not this app's binary, which the update replaces; detached in
    // its own process group because reinstalling the worker ends this process.
    const child = ChildProcess.spawn("node", [Path.join(this.source, "scripts", "update.mjs"), this.statusFile], {
      cwd: this.source,
      detached: true,
      stdio: ["ignore", log, log],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new Error(`Could not start the updater: ${error.message}`)));
    });
    child.unref();
  }
}
