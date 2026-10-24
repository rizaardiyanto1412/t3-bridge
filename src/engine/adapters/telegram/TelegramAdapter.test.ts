import { describe, expect, it } from "vitest";

import { ButtonStore } from "../../core/ButtonStore.ts";
import { PlatformError, type InboundAction, type InboundMessage } from "../../core/types.ts";
import { makeLogger } from "../../log.ts";
import { TelegramAdapter, type TelegramMessage } from "./TelegramAdapter.ts";

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function setup(options: { rejectHtmlOnce?: boolean } = {}) {
  const calls: Call[] = [];
  const inbound: InboundMessage[] = [];
  const actions: InboundAction[] = [];
  let id = 100;
  let rejected = false;
  const adapter = new TelegramAdapter("1:x", makeLogger(() => {}), "Test", new ButtonStore(null));
  Object.assign(adapter as unknown as Record<string, unknown>, {
    botUserId: 42,
    username: "keeper_bot",
    request: async (method: string, params: Record<string, unknown> | FormData = {}) => {
      const plain =
        params instanceof FormData ? Object.fromEntries([...params.keys()].map((key) => [key, params.get(key)])) : params;
      calls.push({ method, params: plain });
      if (options.rejectHtmlOnce && !rejected && plain.parse_mode === "HTML") {
        rejected = true;
        throw new PlatformError("Telegram: Bad Request: can't parse entities", 400, false);
      }
      if (method === "getFile") return { file_path: "photos/1.jpg" };
      return { message_id: ++id };
    },
    handlers: {
      onMessage: async (message: InboundMessage) => void inbound.push(message),
      onAction: async (action: InboundAction) => void actions.push(action),
      onStatus: () => {},
    },
  });
  const update = (value: Record<string, unknown>) =>
    (adapter as unknown as { onUpdate: (update: unknown) => Promise<void> }).onUpdate({
      update_id: 1,
      ...value,
    });
  return { adapter, calls, inbound, actions, update };
}

const user = { id: 7, is_bot: false, first_name: "Riza" };
const message = (extra: Partial<TelegramMessage>, text: string | null = "hello"): TelegramMessage => ({
  message_id: 5,
  from: user,
  chat: { id: 7, type: "private" },
  ...(text === null ? {} : { text }),
  ...extra,
});

describe("TelegramAdapter inbound", () => {
  it("reads a direct message", async () => {
    const { inbound, update } = setup();
    await update({ message: message({}) });
    expect(inbound[0]).toMatchObject({
      conversation: { id: "7", label: "Direct message" },
      ref: { channel: "7", ts: "5" },
      userId: "7",
      userName: "Riza",
      isDirect: true,
      text: "hello",
      replyTo: null,
    });
  });

  it("takes the bot's @name out of a group message and notes the mention", async () => {
    const { inbound, update } = setup();
    await update({
      message: message({
        chat: { id: -100, type: "supergroup", title: "Team" },
        text: "@keeper_bot fix the login page",
        entities: [{ type: "mention", offset: 0, length: 11 }],
        reply_to_message: { message_id: 3, chat: { id: -100, type: "supergroup" } },
      }),
    });
    expect(inbound[0]).toMatchObject({
      isDirect: false,
      mentionsBot: true,
      text: "fix the login page",
      replyTo: { channel: "-100", ts: "3" },
    });
  });

  it("offers the replied-to message as earlier context", async () => {
    const { inbound, update } = setup();
    await update({
      message: message({
        chat: { id: -100, type: "supergroup", title: "Team" },
        text: "@keeper_bot is this on our end?",
        entities: [{ type: "mention", offset: 0, length: 11 }],
        reply_to_message: {
          message_id: 3,
          chat: { id: -100, type: "supergroup", title: "Team" },
          from: { id: 8, is_bot: true, first_name: "WPKeeper" },
          caption: "Backup failed",
          photo: [{ file_id: "p", width: 9, height: 9, file_size: 10 }],
        },
      }),
    });
    const [earlier] = await inbound[0]!.earlier!();
    expect([earlier!.author, earlier!.text, earlier!.files.map((file) => file.name)]).toEqual([
      "WPKeeper",
      "Backup failed",
      ["photo-3.jpg"],
    ]);
  });

  it("drops the @bot suffix from commands", async () => {
    const { inbound, update } = setup();
    await update({
      message: message({
        chat: { id: -100, type: "group", title: "Team" },
        text: "/stop@keeper_bot",
        entities: [{ type: "bot_command", offset: 0, length: 16 }],
      }),
    });
    expect(inbound[0]).toMatchObject({ text: "/stop", mentionsBot: true });
  });

  it("does not treat a forum topic's opening message as a reply", async () => {
    const { inbound, update } = setup();
    await update({
      message: message({
        chat: { id: -100, type: "supergroup", title: "Team" },
        is_topic_message: true,
        message_thread_id: 9,
        reply_to_message: { message_id: 9, chat: { id: -100, type: "supergroup" } },
      }),
    });
    expect(inbound[0]!.replyTo).toBeNull();
    expect(inbound[0]!.conversation.meta).toEqual({ topic: "9" });
  });

  it("quotes forwarded messages with their author and gathers album photos into one request", async () => {
    const { inbound, update } = setup();
    await update({
      message: message({
        text: "the error",
        forward_origin: { type: "user", sender_user: { id: 8, is_bot: false, first_name: "Ann" } },
      }),
    });
    expect(inbound[0]!.text).toBe("Forwarded message from Ann:\n> the error");

    const photo = (fileId: string) => [{ file_id: fileId, width: 90, height: 90, file_size: 10 }];
    await update({ message: message({ message_id: 6, caption: "both", media_group_id: "g", photo: photo("a") }, null) });
    await update({ message: message({ message_id: 7, media_group_id: "g", photo: photo("b") }, null) });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(inbound).toHaveLength(2);
    expect(inbound[1]!.text).toBe("both");
    expect(inbound[1]!.files.map((file) => file.name)).toEqual(["photo-6.jpg", "photo-7.jpg"]);
  });

  it("answers a button press and turns it into an action", async () => {
    const { adapter, calls, actions, update } = setup();
    const ref = await adapter.upsert(
      { id: "7", label: "Direct message" },
      {
        kind: "approval",
        threadId: "t",
        requestId: "r",
        source: "Orchestrator",
        prompt: "Deploy?",
        decisions: ["accept", "decline"],
        resolved: null,
      },
      null,
    );
    const keyboard = calls[0]!.params.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const approve = keyboard.inline_keyboard[0]![0]!;
    expect(approve.text).toBe("Approve");
    expect(approve.callback_data.length).toBeLessThanOrEqual(64);
    await update({ callback_query: { id: "cb", from: user, data: approve.callback_data } });
    expect(actions).toEqual([
      { type: "approval", userId: "7", threadId: "t", requestId: "r", decision: "accept" },
    ]);
    expect(calls.at(-1)).toMatchObject({ method: "answerCallbackQuery", params: { callback_query_id: "cb" } });

    await update({ callback_query: { id: "old", from: user, data: "t3:gone" } });
    expect(calls.at(-1)!.params.show_alert).toBe(true);
    expect(ref.ts).toBe("101");
  });
});

describe("TelegramAdapter.upsert", () => {
  const dm = { id: "7", label: "Direct message" };

  it("edits a streaming reply in place and removes the writing note when done", async () => {
    const { adapter, calls } = setup();
    const ref = await adapter.upsert(dm, { kind: "assistant", markdown: "Hel", streaming: true, images: [] }, null);
    await adapter.upsert(dm, { kind: "assistant", markdown: "**Hello** there", streaming: false, images: [] }, ref);
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(calls[0]!.params.text).toContain("writing…");
    expect(calls[1]!.params).toMatchObject({
      message_id: Number(ref.ts),
      text: "<b>Hello</b> there",
      parse_mode: "HTML",
    });
  });

  it("previews a long reply and attaches all of it as a file", async () => {
    const { adapter, calls } = setup();
    const markdown = `# Audit\n\nAll good.\n\n${"detail ".repeat(1200)}`;
    const ref = await adapter.upsert(dm, { kind: "assistant", markdown, streaming: false, images: [] }, null);
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendDocument"]);
    expect(String(calls[0]!.params.text)).toContain("Full reply attached");
    expect((calls[1]!.params.document as File).name).toBe("Audit.md");
    expect(ref.report).toBe("done");
  });

  it("sends plain text when Telegram cannot parse the formatting", async () => {
    const { adapter, calls } = setup({ rejectHtmlOnce: true });
    await adapter.upsert(dm, { kind: "notice", markdown: "**odd** text" }, null);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params).toMatchObject({ text: "odd text" });
    expect(calls[1]!.params.parse_mode).toBeUndefined();
  });

  it("posts into the forum topic a request came from", async () => {
    const { adapter, calls } = setup();
    await adapter.upsert(
      { id: "-100", label: "Team", meta: { topic: "9" } },
      { kind: "notice", markdown: "hi" },
      null,
    );
    expect(calls[0]!.params.message_thread_id).toBe(9);
  });

  it("shows run state as a reaction Telegram allows", async () => {
    const { adapter, calls } = setup();
    await adapter.setRunStatus({ channel: "7", ts: "5" }, "completed");
    expect(calls[0]).toMatchObject({
      method: "setMessageReaction",
      params: { chat_id: "7", message_id: 5, reaction: [{ type: "emoji", emoji: "👍" }] },
    });
    await adapter.stop();
  });
});
