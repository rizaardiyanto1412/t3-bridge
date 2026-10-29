import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeLogger } from "../log.ts";
import type { BotConfig } from "../store.ts";
import type { T3Client } from "../t3/T3Client.ts";
import { BotRuntime, earlierText } from "./BotRuntime.ts";
import type { ChatAdapter, EarlierMessage, InboundMessage, OutboundPost } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-runtime-"));
  dirs.push(dataDir);
  const memoryDir = Path.join(dataDir, "memory");
  const dispatched: Array<{ text: string; attachments: unknown[] }> = [];
  const uploaded: string[] = [];
  const replies: string[] = [];
  const posts: OutboundPost[] = [];
  let feed: ((item: unknown) => Promise<void>) | null = null;
  const t3 = {
    subscribeThread: (input: { onItem: (item: unknown) => Promise<void> }) => {
      feed = input.onItem;
      return () => {};
    },
    dispatch: async (command: { type: string; text?: string; attachments?: unknown[] }) => {
      if (command.type === "message.dispatch")
        dispatched.push({ text: command.text ?? "", attachments: command.attachments ?? [] });
      return { sequence: 1 };
    },
    uploadAttachment: async (input: { name: string }) => {
      uploaded.push(input.name);
      return { type: "image", attachmentId: `att-${input.name}` };
    },
  } as unknown as T3Client;
  const adapter: ChatAdapter = {
    mentionHint: "write @Name to notify someone",
    start: async () => {},
    stop: async () => {},
    upsert: async (_conversation, post) => {
      posts.push(post);
      return { ts: "posted" };
    },
    setRunStatus: async () => {},
    reply: async (_message, text) => {
      replies.push(text);
    },
  };
  const bot: BotConfig = {
    id: "bot-1",
    name: "Developer",
    platform: "slack",
    enabled: true,
    threadId: "thread-1",
    allowedUserIds: ["U1"],
    instructions: "",
    reminder: false,
    createdAt: new Date().toISOString(),
  };
  const runtime = new BotRuntime({
    bot,
    adapter,
    t3,
    dataDir,
    log: makeLogger(() => {}),
    platformLabel: "Slack",
    claimOwner: async () => {},
    isBridgeMessage: () => false,
    threaded: true,
    createFreshThread: async () => ({ threadId: "x", title: "x" }),
    switchThread: async () => {},
    memoryDir: async () => memoryDir,
  });
  await runtime.start();
  return { runtime, dispatched, uploaded, replies, posts, memoryDir, feed: (item: unknown) => feed!(item) };
}

const alert: EarlierMessage = {
  author: "WPKeeper",
  text: "example.com: backup failed\nThe panel stopped 4 times during this backup.",
  files: [
    {
      name: "chart.png",
      mimeType: "image/png",
      sizeBytes: 3,
      download: async () => Buffer.from("png"),
    },
  ],
};

function mention(text: string, ts: string, earlier: () => Promise<EarlierMessage[]>): InboundMessage {
  return {
    conversation: { id: "C1", label: "#alerts" },
    ref: { channel: "C1", ts },
    userId: "U1",
    userName: "Riza",
    isDirect: false,
    mentionsBot: true,
    text,
    files: [],
    replyTo: { channel: "C1", ts: "100.000" },
    earlier,
  };
}

describe("BotRuntime brought into a conversation", () => {
  it("sends the alert it was mentioned under, with its files, once per thread", async () => {
    const { runtime, dispatched, uploaded } = await setup();
    let loads = 0;
    const earlier = async () => {
      loads += 1;
      return [alert];
    };
    await runtime.handleMessage(mention("Is this issue on our end? Please repro", "101.000", earlier));
    expect(dispatched[0]!.text).toMatch(/^\[Slack · Riza · .* · write @Name to notify someone\]\n/);
    expect(dispatched[0]!.text).toContain('thread "example.com: backup failed');
    expect(dispatched[0]!.text).toContain("WPKeeper [1 file attached]:\n> example.com: backup failed");
    expect(dispatched[0]!.text).toMatch(/The request:\n\nIs this issue on our end\? Please repro$/);
    expect(uploaded).toEqual(["chart.png"]);

    // A follow-up in the same thread builds on what T3 already has.
    await runtime.handleMessage(mention("Any news?", "102.000", earlier));
    expect(loads).toBe(1);
    expect(dispatched[1]!.text).not.toContain("WPKeeper");
    expect(dispatched[1]!.text).toContain('thread "example.com: backup failed');
    await runtime.stop();
  });

  it("sends what a mention without a reply missed, each time", async () => {
    const { runtime, dispatched } = await setup();
    const missed = (text: string) => async () => [{ author: "Dana", text, files: [] }];
    await runtime.handleMessage({ ...mention("Thoughts?", "101.000", missed("first")), replyTo: null });
    await runtime.handleMessage({ ...mention("And now?", "102.000", missed("second")), replyTo: null });
    expect(dispatched[0]!.text).toContain("Dana:\n> first");
    expect(dispatched[1]!.text).toContain("Dana:\n> second");
    await runtime.stop();
  });

  it("still sends the request when the earlier messages cannot be read", async () => {
    const { runtime, dispatched } = await setup();
    await runtime.handleMessage(
      mention("Look at this", "101.000", async () => {
        throw new Error("not_in_channel");
      }),
    );
    expect(dispatched[0]!.text).toMatch(/\]\nLook at this$/);
    await runtime.stop();
  });
});

describe("earlierText", () => {
  it("keeps the opening message and the newest replies of a long thread", () => {
    const replies = Array.from({ length: 40 }, (_, index) => ({
      author: "Ann",
      text: `reply ${index} ${"x".repeat(300)}`,
      files: [],
    }));
    const text = earlierText([alert, ...replies]);
    expect(text).toContain("> example.com: backup failed");
    expect(text).toContain("reply 39");
    expect(text).not.toContain("reply 0 ");
    expect(text).toMatch(/\(\d+ more messages not shown\)/);
    expect(text.length).toBeLessThan(7500);
  });
});

function direct(text: string, ts = "200.000"): InboundMessage {
  return {
    conversation: { id: "D1", label: "DM" },
    ref: { channel: "D1", ts },
    userId: "U1",
    userName: "Tyler",
    isDirect: true,
    mentionsBot: false,
    text,
    files: [],
    replyTo: null,
  };
}

describe("BotRuntime project memory", () => {
  it("saves and forgets facts from chat without sending them to T3", async () => {
    const { runtime, dispatched, replies, memoryDir } = await setup();
    await runtime.handleMessage(direct("!remember The marketing site is reached over SSH"));
    await runtime.handleMessage(direct("!remember the marketing site is reached over SSH", "201.000"));
    const index = await FS.readFile(Path.join(memoryDir, "MEMORY.md"), "utf8");
    expect(index).toMatch(/^- The marketing site is reached over SSH _\(Tyler, \d{4}-\d{2}-\d{2}\)_\n$/);
    expect(replies).toEqual([
      "🧠 Saved to project memory: The marketing site is reached over SSH",
      "🧠 Project memory already has that.",
    ]);

    await runtime.handleMessage(direct("!forget marketing site", "202.000"));
    expect(await FS.readFile(Path.join(memoryDir, "MEMORY.md"), "utf8")).toBe("");
    expect(replies[2]).toContain("Removed from project memory");
    expect(dispatched).toEqual([]);
    await runtime.stop();
  });

  it("saves a finished subagent's REMEMBER: lines once and says so in chat", async () => {
    const { runtime, posts, memoryDir, feed } = await setup();
    // The notice goes to the thread someone last wrote in.
    await runtime.handleMessage(direct("Reorder the footer"));
    const subagent = {
      id: "sub-1",
      runId: null,
      parentNodeId: "node-1",
      childThreadId: null,
      title: "Find the footer",
      prompt: "Find the footer",
      model: "claude-opus-5-5",
      status: "completed",
      progress: null,
      result: "Done.\n\n- **REMEMBER:** The footer is Code Snippets row 17\nREMEMBER: Purge with wp bs_cache purge_cache",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    const event = { kind: "event", sequence: 2, event: { type: "subagent.updated", payload: subagent } };
    await feed(event);
    await feed({ ...event, sequence: 3 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const index = await FS.readFile(Path.join(memoryDir, "MEMORY.md"), "utf8");
    expect(index.split("\n").filter(Boolean)).toEqual([
      expect.stringMatching(/^- The footer is Code Snippets row 17 _\(subagent "Find the footer", /),
      expect.stringMatching(/^- Purge with wp bs_cache purge_cache _\(subagent "Find the footer", /),
    ]);
    const notices = posts.filter((post) => post.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ markdown: expect.stringContaining("• The footer is Code Snippets row 17") });
    await runtime.stop();
  });
});
