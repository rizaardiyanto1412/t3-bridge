import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  displayPath,
  forgetFact,
  memoryDir,
  memoryInstructions,
  readMemory,
  rememberedFacts,
  rememberFact,
  withoutRememberLines,
  writeMemoryFile,
} from "./memory.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

async function tempDir() {
  const dir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-memory-"));
  dirs.push(dir);
  return Path.join(dir, "memory");
}

describe("memoryDir", () => {
  it("is the folder Claude Code keeps for the project", () => {
    expect(memoryDir("/Users/riza/Code/paywall-project", "/Users/riza")).toBe(
      "/Users/riza/.claude/projects/-Users-riza-Code-paywall-project/memory",
    );
    expect(memoryDir("/Users/riza/.t3/worktrees/wp_keeper", "/Users/riza")).toBe(
      "/Users/riza/.claude/projects/-Users-riza--t3-worktrees-wp-keeper/memory",
    );
  });

  it("is named in the instructions the way the agent would type it", () => {
    const dir = memoryDir("/Users/riza/Code/app", "/Users/riza");
    expect(displayPath(dir, "/Users/riza")).toBe("~/.claude/projects/-Users-riza-Code-app/memory");
    expect(memoryInstructions(Path.join(OS.homedir(), "x"))).toContain("Project memory: ~/x/MEMORY.md");
  });
});

describe("REMEMBER: lines", () => {
  const report = [
    "Reordered the footer.",
    "",
    "REMEMBER: The footer is Code Snippets row 17",
    "- **REMEMBER:** Purge with `wp bs_cache purge_cache`",
    "  * remember: lower case counts too",
    "REMEMBER:",
    "Not a REMEMBER: line in the middle of a sentence.",
  ].join("\n");

  it("finds each marked fact", () => {
    expect(rememberedFacts(report)).toEqual([
      "The footer is Code Snippets row 17",
      "Purge with `wp bs_cache purge_cache`",
      "lower case counts too",
    ]);
  });

  it("leaves them out of the chat reply", () => {
    expect(withoutRememberLines(report)).toBe(
      "Reordered the footer.\n\nNot a REMEMBER: line in the middle of a sentence.",
    );
  });
});

describe("memory files", () => {
  it("adds facts once, keeps what Claude wrote, and forgets by words", async () => {
    const dir = await tempDir();
    await writeMemoryFile(dir, "MEMORY.md", "- [Docs SSH](docs-ssh.md) — reach the docs site");
    const day = new Date("2026-10-29T08:00:00Z");
    await Promise.all([
      rememberFact(dir, "Marketing site: SSH as paywallproject_com_live", "Tyler", day),
      rememberFact(dir, "DB prefix is wp_ed565d28c8_", "subagent \"Footer\"", day),
    ]);
    expect(await rememberFact(dir, "db prefix is  WP_ED565D28C8_", "Riza", day)).toBe(false);
    const index = await FS.readFile(Path.join(dir, "MEMORY.md"), "utf8");
    expect(index.split("\n")).toEqual([
      "- [Docs SSH](docs-ssh.md) — reach the docs site",
      "- Marketing site: SSH as paywallproject_com_live _(Tyler, 2026-10-29)_",
      '- DB prefix is wp_ed565d28c8_ _(subagent "Footer", 2026-10-29)_',
      "",
    ]);

    expect(await forgetFact(dir, "db prefix")).toEqual([
      '- DB prefix is wp_ed565d28c8_ _(subagent "Footer", 2026-10-29)_',
    ]);
    expect(await forgetFact(dir, "nothing like this")).toEqual([]);
  });

  it("lists the index first and keeps names inside the folder", async () => {
    const dir = await tempDir();
    expect(await readMemory(dir)).toEqual([{ name: "MEMORY.md", text: "" }]);
    await writeMemoryFile(dir, "stripe-keys.md", "Keys live in .env.testing");
    await writeMemoryFile(dir, "MEMORY.md", "- [Stripe keys](stripe-keys.md)\n");
    expect((await readMemory(dir)).map((file) => file.name)).toEqual(["MEMORY.md", "stripe-keys.md"]);
    expect(() => writeMemoryFile(dir, "../escape.md", "x")).toThrow();
    expect(() => writeMemoryFile(dir, "notes.txt", "x")).toThrow();
    await writeMemoryFile(dir, "stripe-keys.md", "  ");
    expect((await readMemory(dir)).map((file) => file.name)).toEqual(["MEMORY.md"]);
  });
});
