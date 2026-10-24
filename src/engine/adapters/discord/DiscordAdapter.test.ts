import { describe, expect, it } from "vitest";

import { ButtonStore } from "../../core/ButtonStore.ts";
import type { InboundAction, InboundMessage } from "../../core/types.ts";
import { makeLogger } from "../../log.ts";
import { DiscordAdapter } from "./DiscordAdapter.ts";
import { toDiscordMarkdown } from "./format.ts";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function setup() {
  const calls: Call[] = [];
  const inbound: InboundMessage[] = [];
  const actions: InboundAction[] = [];
  const sent: unknown[] = [];
  let id = 100;
  const adapter = new DiscordAdapter("token", makeLogger(() => {}), "Test", new ButtonStore(null));
  const internals = adapter as unknown as Record<string, unknown>;
  Object.assign(internals, {
    botUserId: "999",
    applicationId: "app",
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST" && path.endsWith("/messages"))
        return { id: String(++id), channel_id: path.split("/")[2] };
      if (path === "/users/@me/channels") return { id: "dm-1" };
      return undefined;
    },
    send: (payload: unknown) => void sent.push(payload),
    handlers: {
      onMessage: async (message: InboundMessage) => void inbound.push(message),
      onAction: async (action: InboundAction) => void actions.push(action),
      onStatus: () => {},
    },
  });
  const dispatch = async (type: string, data: unknown) => {
    (internals.onDispatch as (type: string, data: unknown) => void).call(adapter, type, data);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { adapter, internals, calls, inbound, actions, sent, dispatch };
}

const author = { id: "7", username: "riza", global_name: "Riza" };
const base = { id: "m1", channel_id: "c1", type: 0, author, content: "hello" };

describe("DiscordAdapter inbound", () => {
  it("reads a direct message", async () => {
    const { inbound, dispatch } = setup();
    await dispatch("MESSAGE_CREATE", base);
    expect(inbound[0]).toMatchObject({
      conversation: { id: "c1", label: "Direct message" },
      ref: { channel: "c1", ts: "m1" },
      userId: "7",
      userName: "Riza",
      isDirect: true,
      mentionsBot: false,
      text: "hello",
      replyTo: null,
    });
  });

  it("takes the bot mention out of a server message and names other mentions", async () => {
    const { inbound, dispatch } = setup();
    await dispatch("MESSAGE_CREATE", {
      ...base,
      guild_id: "g",
      member: { nick: "Riz" },
      content: "<@999> ask <@!5> about it",
      mentions: [{ id: "999", username: "bot" }, { id: "5", username: "ann" }],
      message_reference: { type: 0, message_id: "m0", channel_id: "c1" },
    });
    expect(inbound[0]).toMatchObject({
      isDirect: false,
      mentionsBot: true,
      userName: "Riz",
      text: "ask @ann about it",
      replyTo: { channel: "c1", ts: "m0" },
    });
  });

  it("quotes forwarded messages and is not fooled by replays or bots", async () => {
    const { inbound, dispatch } = setup();
    const forward = {
      ...base,
      content: "",
      message_reference: { type: 1, message_id: "x" },
      message_snapshots: [
        {
          message: {
            content: "it broke",
            attachments: [{ id: "a", filename: "log.txt", size: 3, url: "https://cdn/x", content_type: "text/plain; charset=utf-8" }],
          },
        },
      ],
    };
    await dispatch("MESSAGE_CREATE", forward);
    await dispatch("MESSAGE_CREATE", forward);
    await dispatch("MESSAGE_CREATE", { ...base, id: "m2", author: { ...author, bot: true } });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.text).toBe("Forwarded message:\n> it broke");
    expect(inbound[0]!.replyTo).toBeNull();
    expect(inbound[0]!.files[0]).toMatchObject({ name: "log.txt", mimeType: "text/plain" });
  });

  it("offers the replied-to message, embeds included, as earlier context", async () => {
    const { inbound, dispatch } = setup();
    await dispatch("MESSAGE_CREATE", {
      ...base,
      guild_id: "g",
      type: 19,
      content: "<@999> is this on our end?",
      mentions: [{ id: "999", username: "bot" }],
      message_reference: { type: 0, message_id: "m0", channel_id: "c1" },
      referenced_message: {
        ...base,
        id: "m0",
        author: { id: "5", username: "wpkeeper", bot: true },
        content: "",
        embeds: [{ title: "Backup failed", url: "https://salemreporter.com", description: "Stopped 4 times" }],
      },
    });
    expect(await inbound[0]!.earlier!()).toEqual([
      { author: "wpkeeper", text: "Backup failed (https://salemreporter.com)\nStopped 4 times", files: [] },
    ]);
  });

  it("stops the agent on a 🛑 reaction", async () => {
    const { actions, dispatch } = setup();
    await dispatch("MESSAGE_REACTION_ADD", { user_id: "7", emoji: { name: "🛑" } });
    await dispatch("MESSAGE_REACTION_ADD", { user_id: "7", emoji: { name: "👍" } });
    expect(actions).toEqual([{ type: "stop", userId: "7" }]);
  });

  it("acknowledges a button press and turns it into an action", async () => {
    const { adapter, calls, actions, dispatch } = setup();
    await adapter.upsert(
      { id: "c1", label: "" },
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
    const rows = (calls[0]!.body as { components: Array<{ components: Array<{ custom_id: string; label: string; style: number }> }> }).components;
    const [approve, decline] = rows[0]!.components;
    expect([approve!.label, approve!.style, decline!.label, decline!.style]).toEqual(["Approve", 1, "Decline", 4]);
    await dispatch("INTERACTION_CREATE", {
      id: "i1",
      token: "tok",
      type: 3,
      data: { custom_id: approve!.custom_id },
      member: { user: author },
    });
    expect(calls.at(-1)).toMatchObject({ path: "/interactions/i1/tok/callback", body: { type: 6 } });
    expect(actions).toEqual([
      { type: "approval", userId: "7", threadId: "t", requestId: "r", decision: "accept" },
    ]);
    await dispatch("INTERACTION_CREATE", { id: "i2", token: "tok2", type: 3, data: { custom_id: "t3:gone" }, user: author });
    expect(calls.at(-1)).toMatchObject({ path: "/webhooks/app/tok2", body: { flags: 64 } });
  });
});

describe("DiscordAdapter.upsert", () => {
  const dm = { id: "c1", label: "Direct message" };

  it("edits a streaming reply in place, then splits a long finished reply across messages", async () => {
    const { adapter, calls } = setup();
    const ref = await adapter.upsert(dm, { kind: "assistant", markdown: "Hel", streaming: true, images: [] }, null);
    expect((calls[0]!.body as { content: string }).content).toContain("writing…");
    const markdown = Array.from({ length: 5 }, (_, index) => `Paragraph ${index} ${"x".repeat(900)}`).join("\n\n");
    const after = await adapter.upsert(dm, { kind: "assistant", markdown, streaming: false, images: [] }, ref);
    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH", "POST", "POST"]);
    expect(calls[1]!.path).toBe(`/channels/c1/messages/${ref.ts}`);
    expect(after.more?.split(",")).toHaveLength(2);
    // The text shrinks again: the extra messages go away.
    await adapter.upsert(dm, { kind: "assistant", markdown: "Short now", streaming: false, images: [] }, after);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  });

  it("previews a very long reply and attaches all of it as a file", async () => {
    const { adapter, calls } = setup();
    const markdown = `# Audit\n\nAll good.\n\n${"detail ".repeat(1200)}`;
    await adapter.upsert(dm, { kind: "assistant", markdown, streaming: false, images: [] }, null);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body as { content: string }).content).toContain("Full reply attached");
    const form = calls[1]!.body as FormData;
    expect((form.get("files[0]") as File).name).toBe("Audit.md");
  });

  it("removes the buttons once a question is answered", async () => {
    const { adapter, calls } = setup();
    const question = {
      kind: "question" as const,
      threadId: "t",
      requestId: "r",
      source: "Orchestrator",
      questions: [
        {
          id: "q",
          header: "Branch",
          question: "Which?",
          options: [{ label: "main", description: "", value: "main" }],
          multiSelect: false,
          allowCustomAnswer: true,
        },
      ],
      resolved: false,
    };
    const ref = await adapter.upsert(dm, question, null);
    await adapter.upsert(dm, { ...question, resolved: true }, ref);
    expect((calls[0]!.body as { components: unknown[] }).components).toHaveLength(1);
    expect((calls[1]!.body as { components: unknown[] }).components).toEqual([]);
  });

  it("shows run state as reactions and replaces the previous one", async () => {
    const { adapter, calls } = setup();
    await adapter.setRunStatus({ channel: "c1", ts: "m1" }, "completed", "running");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /channels/c1/messages/m1/reactions/${encodeURIComponent("👀")}/@me`,
      `PUT /channels/c1/messages/m1/reactions/${encodeURIComponent("✅")}/@me`,
    ]);
    await adapter.stop();
  });
});

describe("DiscordAdapter gateway", () => {
  it("identifies on a new session and resumes an existing one", () => {
    const { internals, sent } = setup();
    const onPayload = (payload: unknown) =>
      (internals.onPayload as (payload: unknown) => void).call(internals, payload);
    onPayload({ op: 10, d: { heartbeat_interval: 60_000 }, s: null, t: null });
    expect(sent[0]).toMatchObject({ op: 2, d: { token: "token" } });
    onPayload({ op: 0, d: { session_id: "s1", resume_gateway_url: "wss://resume" }, s: 4, t: "READY" });
    onPayload({ op: 10, d: { heartbeat_interval: 60_000 }, s: null, t: null });
    expect(sent[1]).toEqual({ op: 6, d: { token: "token", session_id: "s1", seq: 4 } });
    clearInterval(internals.heartbeat as NodeJS.Timeout);
  });

  it("gives up on a rejected token and retries without a refused intent", async () => {
    const { internals } = setup();
    const onClose = (code: number) => (internals.onClose as (code: number) => void).call(internals, code);
    let rejected: Error | null = null;
    internals.ready = { resolve: () => {}, reject: (error: Error) => (rejected = error) };
    onClose(4004);
    expect(rejected).toEqual(new Error("Discord rejected the bot token"));
    expect(internals.reconnectTimer).toBeNull();

    internals.intents = (internals.intents as number) | (1 << 15);
    internals.ready = { resolve: () => {}, reject: () => {} };
    onClose(4014);
    expect((internals.intents as number) & (1 << 15)).toBe(0);
    expect(internals.reconnectTimer).not.toBeNull();
    clearTimeout(internals.reconnectTimer as NodeJS.Timeout);
  });
});

describe("toDiscordMarkdown", () => {
  it("bolds headings Discord cannot draw and puts tables in a code block", () => {
    expect(toDiscordMarkdown("#### Deep\n| a | b |\n|---|---|\n| 1 | 2 |\nafter")).toBe(
      "**Deep**\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nafter",
    );
  });
});
