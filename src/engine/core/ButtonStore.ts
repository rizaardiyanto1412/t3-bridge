import * as Crypto from "node:crypto";

import { readJson, writeJsonAtomic } from "../store.ts";
import type { ButtonAction } from "./chatText.ts";

const MAX_BUTTONS = 1000;

/**
 * Discord and Telegram give a button only a short id (100 and 64 bytes), too short for T3's
 * thread and request ids. Each action is stored under a short hash instead, on disk, so
 * buttons posted before a restart still work.
 */
export class ButtonStore {
  private actions: Record<string, ButtonAction> | null = null;
  private writes: Promise<void> = Promise.resolve();

  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
  }

  private async all(): Promise<Record<string, ButtonAction>> {
    this.actions ??=
      (this.file === null ? null : await readJson<Record<string, ButtonAction>>(this.file)) ?? {};
    return this.actions;
  }

  /** The same action always gets the same id, so re-rendering a post stores nothing new. */
  async put(action: ButtonAction): Promise<string> {
    const id = Crypto.createHash("sha256")
      .update(JSON.stringify(action))
      .digest("base64url")
      .slice(0, 16);
    const all = await this.all();
    if (all[id] !== undefined) return id;
    all[id] = action;
    const ids = Object.keys(all);
    if (ids.length > MAX_BUTTONS) for (const old of ids.slice(0, ids.length - MAX_BUTTONS)) delete all[old];
    if (this.file !== null) {
      const file = this.file;
      const snapshot = { ...all };
      this.writes = this.writes.then(() => writeJsonAtomic(file, snapshot)).catch(() => {});
      await this.writes;
    }
    return id;
  }

  async get(id: string): Promise<ButtonAction | null> {
    return (await this.all())[id] ?? null;
  }
}

/** The prefix on every button id the bridge creates. */
export const BUTTON_PREFIX = "t3:";
