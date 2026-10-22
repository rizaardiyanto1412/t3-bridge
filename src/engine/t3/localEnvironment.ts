import * as ChildProcess from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import type { SecretStore } from "../store.ts";
import type { T3Credentials } from "./T3Client.ts";

const BRIDGE_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
const TOKEN_SECRET_KEY = "t3.bearerToken";

export interface LocalEnvironmentOptions {
  /** T3 home directory. Defaults to ~/.t3. */
  readonly baseDir?: string;
  /** Overrides the command that mints a pairing token, for dev servers run from source. */
  readonly pairCommand?: ReadonlyArray<string>;
  /** Overrides the server origin instead of reading server-runtime.json. */
  readonly httpBaseUrl?: string;
}

/**
 * Credentials for the T3 server running on this same machine. The bridge never asks the
 * user to pair: it mints a narrowly scoped one-time pairing token with the local `t3` CLI
 * and exchanges it, and does so again whenever T3 rejects the stored token.
 */
export async function makeLocalCredentials(
  options: LocalEnvironmentOptions,
  secrets: SecretStore,
): Promise<T3Credentials> {
  const baseDir = options.baseDir ?? Path.join(OS.homedir(), ".t3");
  let httpBaseUrl = options.httpBaseUrl ?? (await readServerOrigin(baseDir));
  let pending: Promise<string> | null = null;

  const pair = async () => {
    const credential = await mintPairingCredential(options, baseDir);
    const token = await exchangePairingCredential(httpBaseUrl, credential);
    await secrets.set(TOKEN_SECRET_KEY, token);
    return token;
  };

  return {
    get httpBaseUrl() {
      return httpBaseUrl;
    },
    refreshOrigin: async () => {
      if (options.httpBaseUrl === undefined) httpBaseUrl = await readServerOrigin(baseDir);
    },
    getToken: async ({ refresh }) => {
      if (!refresh) {
        const stored = await secrets.get(TOKEN_SECRET_KEY);
        if (stored) return stored;
      }
      pending ??= pair().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}

async function readServerOrigin(baseDir: string): Promise<string> {
  try {
    const runtime = JSON.parse(
      await FS.readFile(Path.join(baseDir, "userdata", "server-runtime.json"), "utf8"),
    ) as { origin?: string; port?: number };
    if (runtime.origin) return runtime.origin;
    if (runtime.port) return `http://127.0.0.1:${runtime.port}`;
  } catch {
    // Falls through to T3's default port when the server has not written its runtime file.
  }
  return "http://127.0.0.1:3773";
}

async function mintPairingCredential(
  options: LocalEnvironmentOptions,
  baseDir: string,
): Promise<string> {
  const [command, ...prefix] = options.pairCommand ?? [await findT3Cli(baseDir)];
  const args = [
    ...prefix,
    ...(options.pairCommand === undefined ? ["auth", "pairing", "create"] : []),
    ...BRIDGE_SCOPES.flatMap((scope) => ["--scope", scope]),
    "--ttl",
    "5m",
    "--label",
    "T3 Bridge",
    "--json",
  ];
  const output = await new Promise<string>((resolve, reject) => {
    ChildProcess.execFile(
      command!,
      args,
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`t3 pairing failed: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      },
    );
  });
  const json = output.slice(output.indexOf("{"));
  const parsed = JSON.parse(json) as { credential?: string };
  if (!parsed.credential) throw new Error("t3 pairing printed no credential");
  return parsed.credential;
}

async function findT3Cli(baseDir: string): Promise<string> {
  // launchd starts the bridge with a minimal PATH, and ~/.t3/bin/t3 can point at a desktop
  // app that moved. The server that is running right now is the most reliable CLI to use.
  const candidates = [
    await runningServerExecutable(baseDir),
    ...(await installedRuntimes(baseDir)),
    Path.join(baseDir, "bin", "t3"),
    "/opt/homebrew/bin/t3",
    "/usr/local/bin/t3",
    ...(process.env.PATH ?? "").split(Path.delimiter).map((dir) => Path.join(dir, "t3")),
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      await FS.access(candidate, FS.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Could not find the t3 command on this Mac. Is T3 Code installed here?");
}

async function runningServerExecutable(baseDir: string): Promise<string | null> {
  try {
    const runtime = JSON.parse(
      await FS.readFile(Path.join(baseDir, "userdata", "server-runtime.json"), "utf8"),
    ) as { pid?: number };
    if (!runtime.pid) return null;
    const executable = await new Promise<string>((resolve, reject) =>
      ChildProcess.execFile(
        "/bin/ps",
        ["-o", "comm=", "-p", String(runtime.pid)],
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      ),
    );
    // Only the standalone server binary takes CLI subcommands; a desktop app's Electron does not.
    return Path.basename(executable) === "t3" ? executable : null;
  } catch {
    return null;
  }
}

async function installedRuntimes(baseDir: string): Promise<string[]> {
  const versionsDir = Path.join(baseDir, "runtime", "versions");
  try {
    const versions = await FS.readdir(versionsDir);
    const withTimes = await Promise.all(
      versions.map(async (version) => {
        const binary = Path.join(versionsDir, version, "t3");
        const stat = await FS.stat(binary).catch(() => null);
        return { binary, time: stat?.mtimeMs ?? 0 };
      }),
    );
    return withTimes
      .filter((entry) => entry.time > 0)
      .sort((left, right) => right.time - left.time)
      .map((entry) => entry.binary);
  } catch {
    return [];
  }
}

export async function exchangePairingCredential(
  httpBaseUrl: string,
  credential: string,
): Promise<string> {
  const response = await fetch(new URL("/oauth/token", httpBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: BRIDGE_SCOPES.join(" "),
      client_label: "T3 Bridge",
      client_device_type: "bot",
    }),
  });
  if (!response.ok) throw new Error(`T3 rejected the pairing token (${response.status})`);
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("T3 returned no access token");
  return body.access_token;
}
