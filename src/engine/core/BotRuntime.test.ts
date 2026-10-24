import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeLogger } from "../log.ts";
import type { BotConfig } from "../store.ts";
import type { T3Client } from "../t3/T3Client.ts";
import { BotRuntime, earlierText } from "./BotRuntime.ts";
import type { ChatAdapter, EarlierMessage, InboundMessage } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-runtime-"));
  dirs.push(dataDir);
  const dispatched: Array<{ text: string; attachments: unknown[] }> = [];
  const uploaded: string[] = [];
  const t3 = {
    subscribeThread: () => () => {},
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
    start: async () => {},
    stop: async () => {},
    upsert: async () => ({ ts: "posted" }),
    setRunStatus: async () => {},
    reply: async () => {},
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
  });
  await runtime.start();
  return { runtime, dispatched, uploaded };
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
