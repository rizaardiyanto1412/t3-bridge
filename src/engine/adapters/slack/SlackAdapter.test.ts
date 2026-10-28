import { describe, expect, it } from "vitest";

import type { InboundMessage } from "../../core/types.ts";
import { makeLogger } from "../../log.ts";
import { SlackAdapter } from "./SlackAdapter.ts";

interface Call {
  readonly method: string;
  readonly args: Record<string, unknown>;
}

function setup(
  options: {
    threaded?: boolean;
    rejectPlans?: boolean;
    rejectMarkdownOnce?: boolean;
    rejectTaskCards?: boolean;
    unsupportedMethods?: string[];
  } = {},
) {
  const calls: Call[] = [];
  let ts = 0;
  let rejected = false;
  const record = (method: string) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    const blocks = (args.blocks ?? []) as Array<{ type: string }>;
    if (options.rejectPlans && blocks.some((block) => block.type === "plan")) {
      throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    }
    if (options.rejectTaskCards && blocks.some((block) => block.type === "task_card")) {
      throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    }
    if (
      options.rejectMarkdownOnce &&
      !rejected &&
      blocks.some((block) => block.type === "markdown")
    ) {
      rejected = true;
      throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    }
    return { ok: true, channel: args.channel, ts: `${++ts}.000` };
  };
  const adapter = new SlackAdapter(
    { botToken: "xoxb-test", appToken: "xapp-test" },
    makeLogger(() => {}),
    "Test",
    options.threaded ?? false,
  );
  const inbound: InboundMessage[] = [];
  Object.assign(adapter as unknown as Record<string, unknown>, {
    web: {
      chat: {
        getPermalink: async () => ({ permalink: "https://x.slack.com/archives/C1/p1" }),
        postMessage: record("postMessage"),
        update: record("update"),
        delete: record("delete"),
      },
      users: {
        info: async ({ user }: { user: string }) => ({
          user: { profile: { display_name: user === "U3" ? "Tyler" : "Riza" } },
        }),
        list: async () => ({
          members: [
            { id: "U1", name: "riza", real_name: "Riza", profile: { display_name: "Riza" } },
            { id: "U3", name: "tyler", real_name: "Tyler Channell", profile: { display_name: "" } },
            { id: "U4", name: "sam.a", real_name: "Sam Adams", profile: { display_name: "" } },
            { id: "U5", name: "sam.b", real_name: "Sam Brown", profile: { display_name: "" } },
          ],
        }),
      },
      reactions: { add: record("reactions.add"), remove: record("reactions.remove") },
      apiCall: async (method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        if (options.unsupportedMethods?.includes(method)) {
          throw Object.assign(new Error(method), { data: { error: "feature_disabled" } });
        }
        if (method === "canvases.create") return { ok: true, canvas_id: "F123" };
        if (method === "chat.startStream")
          return { ok: true, channel: args.channel, ts: `${++ts}.000` };
        return { ok: true };
      },
      files: {
        info: async ({ file }: { file: string }) =>
          file === "F123"
            ? { file: { permalink: "https://x.slack.com/docs/T1/F123" } }
            : { file: { id: file, name: "Screenshot.png", mimetype: "image/png", size: 42, url_private_download: `https://files.slack.com/${file}` } },
      },
      conversations: {
        open: async () => ({ channel: { id: "D9" } }),
        info: async () => ({ channel: { user: "U1" } }),
        replies: async () => ({
          messages: [
            {
              ts: "100.000",
              bot_profile: { name: "WPKeeper" },
              text: "",
              attachments: [
                {
                  title: "example.com: backup failed",
                  title_link: "https://example.com",
                  text: "The panel stopped 4 times during this backup.",
                  fallback: "backup failed",
                },
              ],
            },
            { ts: "100.500", user: "U2", text: "Seen this before?" },
            { ts: "101.000", user: "U1", text: "<@UBOT> Is this on our end?" },
          ],
        }),
      },
      views: { open: record("views.open") },
    },
    botUserId: "UBOT",
    handlers: {
      onMessage: async (message: InboundMessage) => void inbound.push(message),
      onAction: async () => {},
      onStatus: () => {},
    },
  });
  const onInteractive = (body: Record<string, unknown>) =>
    (
      adapter as unknown as {
        onInteractive: (body: unknown, ack: () => Promise<void>) => Promise<void>;
      }
    ).onInteractive(body, async () => {});
  const onMessage = (event: Record<string, unknown>) =>
    (adapter as unknown as { onMessage: (event: unknown) => Promise<void> }).onMessage(event);
  return { adapter, calls, inbound, onMessage, onInteractive };
}

const dm = { id: "D1", label: "Direct message" };

describe("SlackAdapter.upsert", () => {
  it("splits a long reply into follow-up messages once it is complete", async () => {
    // Without canvases (e.g. a free workspace) a long reply is split across messages.
    const { adapter, calls } = setup({ unsupportedMethods: ["canvases.create"] });
    const markdown = Array.from(
      { length: 30 },
      (_, index) => `Paragraph ${index} ${"x".repeat(900)}`,
    ).join("\n\n");
    const ref = await adapter.upsert(
      dm,
      { kind: "assistant", markdown, streaming: false, images: [] },
      null,
    );
    const posts = calls.filter((call) => call.method === "postMessage");
    expect(posts.length).toBe(3);
    expect(ref.more?.split(",")).toHaveLength(2);
  });

  it("only shows the first chunk while streaming, then edits in place", async () => {
    const { adapter, calls } = setup();
    const ref = await adapter.upsert(
      dm,
      { kind: "assistant", markdown: "Hel", streaming: true, images: [] },
      null,
    );
    await adapter.upsert(
      dm,
      { kind: "assistant", markdown: "Hello there", streaming: false, images: [] },
      ref,
    );
    expect(calls.map((call) => call.method)).toEqual(["postMessage", "update"]);
    expect(calls[1]!.args.ts).toBe(ref.ts);
  });

  it("falls back to mrkdwn sections when Slack rejects markdown blocks", async () => {
    const { adapter, calls } = setup({ rejectMarkdownOnce: true });
    await adapter.upsert(
      dm,
      { kind: "assistant", markdown: "**Done**", streaming: false, images: [] },
      null,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*Done*" } },
    ]);
  });

  const running = {
    kind: "subagent" as const,
    id: "node-1",
    title: "Fix login",
    model: "opus",
    status: "running" as const,
    progress: null,
    result: null,
  };

  it("shows subagents as native task cards with a short result on the card", async () => {
    const { adapter, calls } = setup();
    const ref = await adapter.upsert(dm, running, null);
    await adapter.upsert(dm, { ...running, status: "completed", result: "Fixed it." }, ref);
    const [posted, updated] = calls;
    expect((posted!.args.blocks as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "task_card",
      task_id: "node-1",
      status: "in_progress",
    });
    expect((updated!.args.blocks as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: "complete",
    });
    expect(calls.filter((call) => call.args.thread_ts === ref.ts)).toHaveLength(0);
  });

  it("never repeats a long result under its card; the orchestrator summarizes it", async () => {
    const { adapter, calls } = setup();
    const ref = await adapter.upsert(dm, running, null);
    const done = { ...running, status: "completed" as const, result: "x".repeat(2000) };
    const after = await adapter.upsert(dm, done, ref);
    await adapter.upsert(dm, done, after);
    expect(
      calls.filter((call) => call.method === "postMessage" && call.args.thread_ts === ref.ts),
    ).toHaveLength(0);
  });

  it("falls back to plain cards when the workspace rejects task cards", async () => {
    const { adapter, calls } = setup({ rejectTaskCards: true });
    const ref = await adapter.upsert(dm, running, null);
    await adapter.upsert(dm, { ...running, status: "completed", result: "Fixed it." }, ref);
    const accepted = calls.filter(
      (call) =>
        !(call.args.blocks as Array<{ type: string }> | undefined)?.some(
          (block) => block.type === "task_card",
        ),
    );
    expect(accepted.map((call) => call.method)).toEqual(["postMessage", "update"]);
  });
});

describe("SlackAdapter run status", () => {
  it("marks a run with eyes and Slack's working indicator, then a check mark", async () => {
    const { adapter, calls } = setup();
    const message = { channel: "D1", ts: "7.1" };
    await adapter.setRunStatus(message, "running", null);
    await adapter.setRunStatus(message, "completed", "running");
    expect(calls.map((call) => `${call.method}:${call.args.name ?? call.args.status}`)).toEqual([
      "reactions.add:eyes",
      "agents.sessions.setStatus:processing",
      "reactions.remove:eyes",
      "reactions.add:white_check_mark",
      "agents.sessions.setStatus:active",
    ]);
  });

  it("falls back to the assistant thread status, then gives up quietly", async () => {
    const legacy = setup({ unsupportedMethods: ["agents.sessions.setStatus"] });
    await legacy.adapter.setRunStatus({ channel: "D1", ts: "1" }, "running", null);
    expect(legacy.calls.at(-1)).toMatchObject({
      method: "assistant.threads.setStatus",
      args: { status: "is working…" },
    });
    await legacy.adapter.stop();

    const none = setup({
      unsupportedMethods: ["agents.sessions.setStatus", "assistant.threads.setStatus"],
    });
    await none.adapter.setRunStatus({ channel: "D1", ts: "1" }, "running", null);
    await none.adapter.setRunStatus({ channel: "D1", ts: "1" }, "completed", "running");
    expect(none.calls.filter((call) => call.method.includes("setStatus"))).toHaveLength(2);
  });
});

describe("SlackAdapter inbound messages", () => {
  it("strips the bot mention, decodes Slack escapes and ignores redeliveries", async () => {
    const { inbound, onMessage } = setup();
    const event = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      ts: "5.1",
      text: "<@UBOT> fix a &lt; b",
    };
    await onMessage(event);
    await onMessage(event);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      text: "fix a < b",
      mentionsBot: true,
      isDirect: false,
      userName: "Riza",
    });
  });

  it("ignores bots, edits and its own messages", async () => {
    const { inbound, onMessage } = setup();
    await onMessage({ type: "message", channel: "D1", user: "UBOT", ts: "1" });
    await onMessage({ type: "message", channel: "D1", user: "U1", bot_id: "B1", ts: "2" });
    await onMessage({
      type: "message",
      channel: "D1",
      user: "U1",
      subtype: "message_changed",
      ts: "3",
    });
    expect(inbound).toHaveLength(0);
  });

  it("marks thread replies so they can answer a question", async () => {
    const { inbound, onMessage } = setup();
    await onMessage({
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      ts: "9.2",
      thread_ts: "9.1",
      text: "blue",
    });
    expect(inbound[0]?.replyTo).toEqual({ channel: "D1", ts: "9.1" });
  });
});

describe("SlackAdapter canvases", () => {
  const longReport = `# GitHub check\n\nShort answer: 36 open PRs.\n\n${"| a | b |\n|---|---|\n".repeat(400)}`;

  it("moves a long finished reply into a canvas and posts a preview with its link", async () => {
    const { adapter, calls } = setup();
    const ref = await adapter.upsert(
      dm,
      { kind: "assistant", markdown: longReport, streaming: false, images: [] },
      null,
    );
    expect(ref.canvas).toBe("F123");
    const created = calls.find((call) => call.method === "canvases.create");
    expect(created?.args.title).toBe("GitHub check");
    const posts = calls.filter((call) => call.method === "postMessage");
    expect(posts).toHaveLength(1);
    const text = JSON.stringify(posts[0]!.args.blocks);
    expect(text).toContain("Short answer: 36 open PRs.");
    expect(text).toContain("https://x.slack.com/docs/T1/F123");
    expect(text).not.toContain("| a | b |");
  });

  it("keeps long replies in chat when the workspace has no canvases", async () => {
    const { adapter, calls } = setup({ unsupportedMethods: ["canvases.create"] });
    await adapter.upsert(
      dm,
      { kind: "assistant", markdown: longReport, streaming: false, images: [] },
      null,
    );
    expect(calls.filter((call) => call.method === "postMessage").length).toBeGreaterThan(0);
  });
});

describe("SlackAdapter Send to shortcut", () => {
  it("confirms in a modal, then sends the quoted message with a note from a new DM message", async () => {
    const { calls, inbound, onInteractive } = setup();
    await onInteractive({
      type: "message_action",
      callback_id: "t3_forward",
      trigger_id: "trig",
      user: { id: "U1" },
      channel: { id: "C1" },
      message: { ts: "3.3", user: "U7", text: "The checkout page is broken &amp; slow" },
    });
    const modal = calls.find((call) => call.method === "views.open");
    const id = (modal?.args.view as { private_metadata: string }).private_metadata;
    await onInteractive({
      type: "view_submission",
      user: { id: "U1" },
      view: {
        callback_id: "t3:forward_view",
        private_metadata: id,
        state: { values: { note: { text: { value: "Find the bug" } } } },
      },
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ isDirect: true, userId: "U1", conversation: { id: "D9" } });
    expect(inbound[0]!.text).toContain("Find the bug");
    expect(inbound[0]!.text).toContain("> The checkout page is broken & slow");
    expect(inbound[0]!.text).toContain("https://x.slack.com/archives/C1/p1");
  });
});

describe("SlackAdapter agent layout", () => {
  const thread = { id: "D1", label: "Direct message", threadTs: "100.1" };

  it("streams a reply into the request's thread, appending only new text", async () => {
    const { adapter, calls } = setup({ threaded: true });
    const ref = await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hel", streaming: true, images: [] },
      null,
    );
    await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hello wor", streaming: true, images: [] },
      ref,
    );
    const done = await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hello world.", streaming: false, images: [] },
      ref,
    );
    expect(calls.map((call) => call.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
    expect(calls[0]!.args).toMatchObject({ thread_ts: "100.1", markdown_text: "Hel" });
    expect(calls[1]!.args.markdown_text).toBe("lo wor");
    expect(calls[2]!.args.markdown_text).toBe("ld.");
    expect(done.stream).toBe("done");
  });

  it("posts cards and other replies inside the thread", async () => {
    const { adapter, calls } = setup({ threaded: true });
    await adapter.upsert(
      thread,
      {
        kind: "subagent",
        id: "n1",
        title: "Fix",
        model: null,
        status: "running",
        progress: null,
        result: null,
      },
      null,
    );
    expect(calls[0]).toMatchObject({ method: "postMessage", args: { thread_ts: "100.1" } });
  });

  it("falls back to a normal message when streaming is refused", async () => {
    const { adapter, calls } = setup({ threaded: true, unsupportedMethods: ["chat.startStream"] });
    await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hi", streaming: true, images: [] },
      null,
    );
    expect(calls.map((call) => call.method)).toEqual(["chat.startStream", "postMessage"]);
    expect(calls[1]!.args.thread_ts).toBe("100.1");
  });

  it("sets the working status on the request's thread, not the follow-up message", async () => {
    const { adapter, calls } = setup({ threaded: true });
    await adapter.setRunStatus({ channel: "D1", ts: "100.5" }, "running", null, "100.1");
    expect(calls.find((call) => call.method === "agents.sessions.setStatus")?.args.thread_ts).toBe(
      "100.1",
    );
  });
});

describe("SlackAdapter subagent plans", () => {
  const task = (id: string, status: "running" | "completed") => ({
    id,
    title: `Task ${id}`,
    model: "opus",
    status,
    progress: null,
    result: null,
  });

  it("shows a request's subagents together as one plan", async () => {
    const { adapter, calls } = setup({ threaded: true });
    await adapter.upsert(
      { id: "D1", label: "", threadTs: "1.1" },
      { kind: "subagents", tasks: [task("a", "completed"), task("b", "running")] },
      null,
    );
    const plan = (calls[0]!.args.blocks as Array<Record<string, unknown>>)[0]!;
    expect(plan).toMatchObject({ type: "plan", title: "Subagents · 1/2 done" });
    expect((plan.tasks as unknown[]).length).toBe(2);
  });

  it("falls back to task cards, and remembers it, when plans are refused", async () => {
    const { adapter, calls } = setup({ threaded: true, rejectPlans: true });
    const post = {
      kind: "subagents" as const,
      tasks: [task("a", "running"), task("b", "running")],
    };
    const ref = await adapter.upsert({ id: "D1", label: "", threadTs: "1.1" }, post, null);
    await adapter.upsert(
      { id: "D1", label: "", threadTs: "1.1" },
      { ...post, tasks: [task("a", "completed"), task("b", "running")] },
      ref,
    );
    const types = calls.map((call) => (call.args.blocks as Array<{ type: string }>)[0]!.type);
    expect(types).toEqual(["plan", "task_card", "task_card"]);
  });
});

describe("SlackAdapter forwarded messages", () => {
  it("passes on a forwarded message's text and its files, looking up missing download links", async () => {
    const { inbound, onMessage } = setup();
    await onMessage({
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      ts: "9.9",
      text: "<@UBOT> can you repro this?",
      attachments: [
        {
          is_share: true,
          author_name: "Tyler",
          from_url: "https://x.slack.com/archives/D1/p1",
          text: "Incremental backups are no longer working &amp; it runs full ones",
          files: [{ id: "F777", name: "Screenshot.png" }],
        },
      ],
    });
    const message = inbound[0]!;
    expect(message.text).toContain("can you repro this?");
    expect(message.text).toContain("Forwarded message from Tyler (https://x.slack.com/archives/D1/p1), with 1 file attached:");
    expect(message.text).toContain("> Incremental backups are no longer working & it runs full ones");
    expect(message.files).toHaveLength(1);
    expect(message.files[0]).toMatchObject({ name: "Screenshot.png", mimeType: "image/png" });
  });
});

describe("SlackAdapter thread context", () => {
  it("offers the thread before a mention, alerts in attachments included", async () => {
    const { inbound, onMessage } = setup();
    await onMessage({
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@UBOT> Is this on our end?",
      ts: "101.000",
      thread_ts: "100.000",
    });
    expect(inbound[0]!.replyTo).toEqual({ channel: "C1", ts: "100.000" });
    const earlier = await inbound[0]!.earlier!();
    expect(earlier.map((message) => [message.author, message.text])).toEqual([
      [
        "WPKeeper",
        "example.com: backup failed (https://example.com)\nThe panel stopped 4 times during this backup.",
      ],
      ["Riza", "Seen this before?"],
    ]);
  });

  it("offers nothing for a message that is not in a thread", async () => {
    const { inbound, onMessage } = setup();
    await onMessage({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "hi", ts: "5.000" });
    expect(inbound[0]!.earlier).toBeUndefined();
  });

  it("names the people a message mentions, keeping their ids", async () => {
    const { inbound, onMessage } = setup();
    await onMessage({
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      ts: "6.1",
      text: "<@UBOT> tag <@U3> and see if he likes it",
    });
    expect(inbound[0]!.text).toBe("tag @Tyler (<@U3>) and see if he likes it");
  });

  it("turns the agent's @Name into a Slack mention, leaving shared names and code alone", async () => {
    const { adapter, calls } = setup();
    await adapter.upsert(
      dm,
      {
        kind: "assistant",
        markdown: "@tyler channell, @Riza and @Sam: see `@Tyler` and mail me@Tyler.dev",
        streaming: false,
        images: [],
      },
      null,
    );
    const blocks = calls[0]!.args.blocks as Array<{ text: string }>;
    expect(blocks[0]!.text).toBe("<@U3>, <@U1> and @Sam: see `@Tyler` and mail me@Tyler.dev");
  });

  it("streams a name only once it is complete", async () => {
    const { adapter, calls } = setup({ threaded: true });
    const thread = { id: "D1", label: "Direct message", threadTs: "100.1" };
    const ref = await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hi @", streaming: true, images: [] },
      null,
    );
    await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hi @Ty", streaming: true, images: [] },
      ref,
    );
    await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hi @Tyler Channell, the three page designs are ready", streaming: true, images: [] },
      ref,
    );
    await adapter.upsert(
      thread,
      { kind: "assistant", markdown: "Hi @Tyler Channell, the three page designs are ready.", streaming: false, images: [] },
      ref,
    );
    const streamed = calls
      .filter((call) => call.method === "chat.startStream" || call.method === "chat.appendStream")
      .map((call) => call.args.markdown_text);
    expect(streamed).toEqual(["Hi ", "<@U3>, the three page designs are ready", "."]);
    expect(calls.map((call) => call.method)).not.toContain("update");
  });

  it("writes mentions in a canvas the way canvases take them", async () => {
    const { adapter, calls } = setup();
    await adapter.upsert(
      dm,
      { kind: "assistant", markdown: `@Tyler ${"x".repeat(5000)}`, streaming: false, images: [] },
      null,
    );
    const created = calls.find((call) => call.method === "canvases.create")!;
    expect(
      (created.args.document_content as { markdown: string }).markdown.startsWith("![](@U3) x"),
    ).toBe(true);
  });
});
