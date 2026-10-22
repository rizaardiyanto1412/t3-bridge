import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { LocalEnvironmentOptions } from "./t3/localEnvironment.ts";

export type Platform = "slack";

export interface BotConfig {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly enabled: boolean;
  /** The T3 thread this bot talks to: the orchestrator. */
  readonly threadId: string | null;
  /** Platform user ids allowed to drive the agent. Empty means the first person to DM the bot claims it. */
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly instructions: string;
  /** Prefix every chat message with a one-line reminder of the orchestrator role. */
  readonly reminder: boolean;
  /** Which version of the Slack manifest the app was last set up with; see MANIFEST_VERSION. */
  readonly manifestVersion?: number;
  readonly createdAt: string;
}

export interface BridgeConfig {
  readonly version: 1;
  readonly controlToken: string;
  readonly controlPort: number;
  readonly t3: LocalEnvironmentOptions;
  readonly bots: ReadonlyArray<BotConfig>;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecretCipher {
  readonly encrypt: (plain: string) => Buffer;
  readonly decrypt: (encrypted: Buffer) => string;
}

export const DEFAULT_CONTROL_PORT = 47821;

/** Writes through a temp file so a crash mid-write never leaves half a JSON file behind. */
export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600) {
  await FS.mkdir(Path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Crypto.randomUUID()}.tmp`;
  await FS.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await FS.rename(temp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await FS.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class ConfigStore {
  private config: BridgeConfig | null = null;
  private writes: Promise<void> = Promise.resolve();

  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private get file() {
    return Path.join(this.dataDir, "config.json");
  }

  async load(defaults: Partial<BridgeConfig> = {}): Promise<BridgeConfig> {
    const stored = await readJson<BridgeConfig>(this.file);
    this.config = {
      version: 1,
      controlToken: stored?.controlToken ?? Crypto.randomBytes(24).toString("base64url"),
      controlPort: stored?.controlPort ?? defaults.controlPort ?? DEFAULT_CONTROL_PORT,
      t3: { ...defaults.t3, ...stored?.t3 },
      bots: stored?.bots ?? [],
    };
    if (stored === null) await this.save(this.config);
    return this.config;
  }

  get(): BridgeConfig {
    if (this.config === null) throw new Error("Config not loaded");
    return this.config;
  }

  async update(change: (config: BridgeConfig) => BridgeConfig): Promise<BridgeConfig> {
    const next = change(this.get());
    await this.save(next);
    return next;
  }

  private save(config: BridgeConfig): Promise<void> {
    this.config = config;
    this.writes = this.writes.then(() => writeJsonAtomic(this.file, config));
    return this.writes;
  }
}

/**
 * Secrets live in one file, each value encrypted with the OS keychain key when Electron's
 * safeStorage is available. Without a cipher (tests, plain Node) values are stored as-is in a
 * file only this user can read.
 */
export class FileSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;
  private writes: Promise<void> = Promise.resolve();

  private readonly file: string;
  private readonly cipher: SecretCipher | null;

  constructor(file: string, cipher: SecretCipher | null) {
    this.file = file;
    this.cipher = cipher;
  }

  private async all(): Promise<Record<string, string>> {
    this.cache ??= (await readJson<Record<string, string>>(this.file)) ?? {};
    return this.cache;
  }

  async get(key: string): Promise<string | null> {
    const value = (await this.all())[key];
    if (value === undefined) return null;
    if (this.cipher === null) return value;
    try {
      return this.cipher.decrypt(Buffer.from(value, "base64"));
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const all = await this.all();
    all[key] = this.cipher === null ? value : this.cipher.encrypt(value).toString("base64");
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    const all = await this.all();
    delete all[key];
    await this.flush();
  }

  private flush() {
    const snapshot = { ...this.cache };
    this.writes = this.writes.then(() => writeJsonAtomic(this.file, snapshot));
    return this.writes;
  }
}
