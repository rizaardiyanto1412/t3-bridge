import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ProviderApprovalDecision } from "@t3tools/contracts";

import type {
  AdapterHandlers,
  ChatAdapter,
  ConversationRef,
  ImageRef,
  InboundFile,
  InboundMessage,
  MessageRef,
  OutboundPost,
  Question,
  RunStatus,
} from "../../core/types.ts";
import type { Logger } from "../../log.ts";
import {
  ACTION_ANSWER,
  ACTION_ANSWER_MODAL,
  ACTION_APPROVAL,
  RUN_REACTIONS,
  VIEW_ANSWER,
  VIEW_FORWARD,
  SHORTCUT_FORWARD,
  answerModal,
  forwardModal,
  answersFromView,
  renderPost,
  withoutMarkdownBlocks,
  type Block,
} from "./blocks.ts";
import { reportPreview, reportTitle } from "../../core/markdown.ts";
import { notificationText, splitSlackMarkdown } from "./format.ts";

interface Content {
  readonly text: string;
  readonly blocks: Block[];
  readonly fallbacks?: Block[][];
  readonly kind?: string;
}

export interface SlackTokens {
  readonly botToken: string;
  readonly appToken: string;
}

const STOP_REACTIONS = new Set(["octagonal_sign", "stop_sign", "no_entry"]);

/** Finished replies longer than this go into a Slack canvas, with a short preview in chat. */
export const CANVAS_THRESHOLD = 4000;
/** chat.startStream and chat.appendStream take at most 12,000 characters each. */
const STREAM_CHUNK_LIMIT = 11_000;

interface PendingForward {
  readonly channel: string;
  readonly ts: string;
  readonly author: string;
  readonly text: string;
  readonly files: SlackFile[] | undefined;
}

/** Verifies both tokens before they are saved: the bot token against auth.test, the app token by opening a socket URL. */
export async function testSlackTokens(tokens: SlackTokens) {
  if (!tokens.botToken.startsWith("xoxb-"))
    throw new Error("The bot token should start with xoxb-");
  if (!tokens.appToken.startsWith("xapp-"))
    throw new Error("The app-level token should start with xapp-");
  const web = new WebClient(tokens.botToken);
  const auth = await web.auth.test();
  const app = new WebClient(tokens.appToken);
  await app.apps.connections.open();
  return { team: auth.team ?? "", botUser: auth.user ?? "", botUserId: auth.user_id ?? "" };
}

type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
};

/** A forwarded or shared message rides along in `attachments`, with its own text and files. */
interface SlackSharedMessage {
  is_share?: boolean;
  is_msg_unfurl?: boolean;
  author_id?: string;
  author_name?: string;
  author_subname?: string;
  channel_name?: string;
  from_url?: string;
  text?: string;
  fallback?: string;
  files?: SlackFile[];
  message_blocks?: Array<{ message?: { text?: string; files?: SlackFile[] } }>;
}

interface SlackEventMessage {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  team?: string;
  attachments?: SlackSharedMessage[];
  files?: SlackFile[];
}

/**
 * Slack over Socket Mode, so the bridge needs no public URL. Each bot is its own Slack app
 * with its own pair of tokens.
 */
export class SlackAdapter implements ChatAdapter {
  private readonly web: WebClient;
  private socket: SocketModeClient | null = null;
  private handlers: AdapterHandlers | null = null;
  private botUserId = "";
  private readonly userNames = new Map<string, string>();
  private readonly seenEvents = new Map<string, number>();
  /** Questions by request, so the Answer button can build its modal. */
  private readonly questions = new Map<string, ReadonlyArray<Question>>();
  /** How far down its list of simpler layouts each kind of post had to go to be accepted. */
  private readonly blockLevel = new Map<string, number>();
  /** Which "working" indicator this workspace accepts; null once both have been refused. */
  private sessionStatus: "agents" | "assistant" | null = "agents";
  private readonly statusRefresh = new Map<string, NodeJS.Timeout>();
  /** Messages picked with "Send to …", waiting for the person to confirm in the modal. */
  private readonly pendingForwards = new Map<string, PendingForward>();
  /** Set once the workspace refuses canvases (free plan, disabled); long replies then stay in chat. */
  private canvasesRejected = false;

  private readonly tokens: SlackTokens;
  private readonly log: Logger;
  private readonly name: string;

  /** Slack agent layout: replies go in the request's thread and stream in. */
  private readonly threaded: boolean;
  private streamingRejected = false;
  /** Text already streamed into each open streaming message, to send only what is new. */
  private readonly streamed = new Map<string, string>();

  constructor(tokens: SlackTokens, log: Logger, name: string, threaded = false) {
    this.tokens = tokens;
    this.log = log;
    this.name = name;
    this.threaded = threaded;
    this.web = new WebClient(tokens.botToken, { retryConfig: { retries: 3 } });
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    handlers.onStatus({ state: "connecting" });
    const socket = new SocketModeClient({ appToken: this.tokens.appToken });
    this.socket = socket;

    socket.on(
      "message",
      ({ ack, event }: { ack: () => Promise<void>; event: SlackEventMessage }) => {
        void ack();
        void this.onMessage(event).catch((error: unknown) =>
          this.log.error(`[${this.name}] Slack message`, error),
        );
      },
    );
    socket.on(
      "reaction_added",
      ({ ack, event }: { ack: () => Promise<void>; event: { user: string; reaction: string } }) => {
        void ack();
        if (STOP_REACTIONS.has(event.reaction) && event.user !== this.botUserId) {
          void this.handlers?.onAction({ type: "stop", userId: event.user });
        }
      },
    );
    // Delivered because agent apps must subscribe to it; acknowledged so Slack doesn't resend it.
    socket.on("app_home_opened", ({ ack }: { ack: () => Promise<void> }) => void ack());
    // Slack's own Stop button, shown while the agent session is processing.
    socket.on(
      "agent_session_stopped",
      ({ ack, event }: { ack: () => Promise<void>; event: { user?: string } }) => {
        void ack();
        if (event.user && event.user !== this.botUserId) {
          void this.handlers?.onAction({ type: "stop", userId: event.user });
        }
      },
    );
    socket.on(
      "interactive",
      ({
        ack,
        body,
      }: {
        ack: (response?: unknown) => Promise<void>;
        body: Record<string, unknown>;
      }) => {
        void this.onInteractive(body, ack).catch((error: unknown) => {
          this.log.error(`[${this.name}] Slack interaction`, error);
          void ack();
        });
      },
    );
    socket.on("connected", () =>
      handlers.onStatus({ state: "connected", identity: this.botUserId }),
    );
    socket.on("disconnected", (error?: Error) => {
      if (error) handlers.onStatus({ state: "error", error: error.message });
    });
    socket.on("error", (error: Error) => this.log.warn(`[${this.name}] Slack socket`, error));

    try {
      const auth = await this.web.auth.test();
      this.botUserId = auth.user_id ?? "";
      await socket.start();
      handlers.onStatus({
        state: "connected",
        identity: `${auth.user ?? "bot"} @ ${auth.team ?? "Slack"}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      handlers.onStatus({ state: "error", error: message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.statusRefresh.values()) clearInterval(timer);
    this.statusRefresh.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      // disconnect() only resolves when the socket reports closing, which can never happen on
      // a stuck connection; a bot being restarted must not wait on it.
      await Promise.race([
        socket.disconnect().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      socket.removeAllListeners();
    }
  }

  // ── inbound ─────────────────────────────────────────────────────────────

  private async onMessage(event: SlackEventMessage) {
    if (event.bot_id || !event.user || event.user === this.botUserId) return;
    if (
      event.subtype !== undefined &&
      event.subtype !== "file_share" &&
      event.subtype !== "thread_broadcast"
    )
      return;
    // Socket Mode redelivers events it thinks were not acknowledged in time.
    const eventKey = `${event.channel}:${event.ts}`;
    if (this.seenEvents.has(eventKey)) return;
    this.seenEvents.set(eventKey, Date.now());
    if (this.seenEvents.size > 2000) {
      for (const key of [...this.seenEvents.keys()].slice(0, 1000)) this.seenEvents.delete(key);
    }

    const isDirect = event.channel_type === "im";
    const mention = this.botUserId ? `<@${this.botUserId}>` : null;
    const rawText = event.text ?? "";
    const mentionsBot = mention !== null && rawText.includes(mention);
    const text = (mention ? rawText.replaceAll(mention, "") : rawText).trim();
    const message: InboundMessage = {
      conversation: {
        id: event.channel,
        label: isDirect ? "Direct message" : `<#${event.channel}>`,
        // Slack streams into a channel only when told whom the stream is for.
        meta: { user: event.user, ...(event.team ? { team: event.team } : {}) },
      },
      ref: { channel: event.channel, ts: event.ts },
      userId: event.user,
      userName: await this.userName(event.user),
      isDirect,
      mentionsBot,
      text: [decodeSlackText(text), ...(await this.sharedMessagesText(event.attachments))]
        .filter(Boolean)
        .join("\n\n"),
      files: await this.inboundFiles([
        ...(event.files ?? []),
        ...sharedMessages(event.attachments).flatMap((shared) => sharedFiles(shared)),
      ]),
      replyTo:
        event.thread_ts && event.thread_ts !== event.ts
          ? { channel: event.channel, ts: event.thread_ts }
          : null,
    };
    await this.handlers?.onMessage(message);
  }

  private async onInteractive(
    body: Record<string, unknown>,
    ack: (response?: unknown) => Promise<void>,
  ) {
    const user = (body.user as { id?: string } | undefined)?.id ?? "";
    if (body.type === "block_actions") {
      await ack();
      const action = (
        body.actions as Array<{ action_id: string; value?: string }> | undefined
      )?.[0];
      if (action?.value === undefined) return;
      const value = JSON.parse(action.value) as {
        t: string;
        r: string;
        d?: ProviderApprovalDecision;
        q?: string;
        v?: string;
      };
      if (action.action_id.startsWith(ACTION_APPROVAL) && value.d !== undefined) {
        await this.handlers?.onAction({
          type: "approval",
          userId: user,
          threadId: value.t,
          requestId: value.r,
          decision: value.d,
        });
      } else if (
        action.action_id.startsWith(ACTION_ANSWER) &&
        action.action_id !== ACTION_ANSWER_MODAL &&
        value.q !== undefined
      ) {
        await this.handlers?.onAction({
          type: "answer",
          userId: user,
          threadId: value.t,
          requestId: value.r,
          answers: { [value.q]: value.v ?? "" },
        });
      } else if (action.action_id === ACTION_ANSWER_MODAL) {
        const questions = this.questions.get(`${value.t}:${value.r}`);
        const channel = (body.channel as { id?: string } | undefined)?.id;
        if (questions === undefined) {
          if (channel) {
            await this.web.chat.postEphemeral({
              channel,
              user,
              text: "Reply in this message's thread to answer the question.",
            });
          }
          return;
        }
        await this.web.views.open({
          trigger_id: String(body.trigger_id),
          view: answerModal(value.t, value.r, questions) as never,
        });
      }
      return;
    }
    if (body.type === "message_action" && body.callback_id === SHORTCUT_FORWARD) {
      await ack();
      await this.openForward(body);
      return;
    }
    if (body.type === "view_submission") {
      const view = body.view as {
        callback_id?: string;
        private_metadata?: string;
        state?: { values?: unknown };
      };
      if (view.callback_id === VIEW_FORWARD && view.private_metadata) {
        await ack();
        await this.submitForward(view.private_metadata, user, view.state?.values);
        return;
      }
      if (view.callback_id !== VIEW_ANSWER || !view.private_metadata) return ack();
      const meta = JSON.parse(view.private_metadata) as { t: string; r: string };
      const questions = this.questions.get(`${meta.t}:${meta.r}`) ?? [];
      await ack();
      await this.handlers?.onAction({
        type: "answer",
        userId: user,
        threadId: meta.t,
        requestId: meta.r,
        answers: answersFromView(questions, (view.state?.values ?? {}) as never),
      });
      return;
    }
    await ack();
  }

  /** "Send to <bot>" on any message: confirm in a modal, with room for what to do about it. */
  private async openForward(body: Record<string, unknown>) {
    const message = body.message as {
      ts?: string;
      user?: string;
      bot_id?: string;
      username?: string;
      text?: string;
      files?: SlackEventMessage["files"];
    };
    const channel = (body.channel as { id?: string } | undefined)?.id ?? "";
    const author = message.user ? await this.userName(message.user) : (message.username ?? "a bot");
    const id = Math.random().toString(36).slice(2, 12);
    this.pendingForwards.set(id, {
      channel,
      ts: message.ts ?? "",
      author,
      text: decodeSlackText(message.text ?? ""),
      files: message.files,
    });
    if (this.pendingForwards.size > 50) {
      this.pendingForwards.delete(this.pendingForwards.keys().next().value!);
    }
    await this.web.views.open({
      trigger_id: String(body.trigger_id),
      view: forwardModal(id, this.name, author, decodeSlackText(message.text ?? "")) as never,
    });
  }

  private async submitForward(id: string, user: string, values: unknown) {
    const pending = this.pendingForwards.get(id);
    this.pendingForwards.delete(id);
    if (pending === undefined) return;
    const note =
      (
        values as Record<string, Record<string, { value?: string | null }>> | undefined
      )?.note?.text?.value?.trim() ?? "";
    const permalink = await this.web.chat
      .getPermalink({ channel: pending.channel, message_ts: pending.ts })
      .then((result) => result.permalink ?? null)
      .catch(() => null);
    const conversation = await this.openDirect(user);
    const quoted = pending.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const text = [
      note || "Please look at this message.",
      "",
      `Forwarded from ${pending.author}${pending.channel.startsWith("D") ? "" : ` in <#${pending.channel}>`}${permalink ? ` (${permalink})` : ""}:`,
      quoted || "> (no text)",
    ].join("\n");
    // The forward gets its own DM message, so the run's 👀 and ✅ have somewhere to go.
    const posted = await this.web.chat.postMessage({
      channel: conversation.id,
      text: `📨 Sent to ${this.name}: ${note || "a message"}${permalink ? ` · <${permalink}|original>` : ""}`,
      unfurl_links: false,
    });
    await this.handlers?.onMessage({
      conversation,
      ref: { channel: conversation.id, ts: posted.ts ?? "" },
      userId: user,
      userName: await this.userName(user),
      isDirect: true,
      mentionsBot: true,
      text,
      files: await this.inboundFiles(pending.files ?? []),
      replyTo: null,
    });
  }

  /** Forwarded messages, quoted for the agent with who wrote them and where. */
  private async sharedMessagesText(attachments: SlackSharedMessage[] | undefined): Promise<string[]> {
    const quoted: string[] = [];
    if ((attachments?.length ?? 0) > 0) {
      // Slack's forwarding format is loosely documented; the shape helps if one is missed.
      this.log.info(
        `[${this.name}] message carries ${attachments!.length} attachment(s): ${attachments!
          .map((attachment) => `{${Object.keys(attachment).sort().join(",")}}`)
          .join(" ")}`,
      );
    }
    for (const shared of sharedMessages(attachments)) {
      const body = decodeSlackText(
        shared.text ?? shared.message_blocks?.map((block) => block.message?.text ?? "").join("\n") ?? shared.fallback ?? "",
      ).trim();
      const author = shared.author_name ?? (shared.author_id ? await this.userName(shared.author_id) : "someone");
      const files = sharedFiles(shared).length;
      const header = `Forwarded message from ${author}${shared.channel_name ? ` in #${shared.channel_name}` : ""}${shared.from_url ? ` (${shared.from_url})` : ""}${files > 0 ? `, with ${files} file${files === 1 ? "" : "s"} attached` : ""}:`;
      quoted.push([header, ...(body || "(no text)").split("\n").map((line) => `> ${line}`)].join("\n"));
    }
    return quoted;
  }

  /**
   * Files a message carries. Files inside a forwarded message often come without a download
   * link; files.info supplies it, as long as the bot can see the conversation they were shared in.
   */
  private async inboundFiles(files: ReadonlyArray<SlackFile>): Promise<InboundFile[]> {
    const result: InboundFile[] = [];
    const seen = new Set<string>();
    for (const listed of files) {
      if (seen.has(listed.id)) continue;
      seen.add(listed.id);
      let file = listed;
      if (!file.url_private_download) {
        const info = await this.web.files.info({ file: file.id }).catch((error: unknown) => {
          this.log.warn(`[${this.name}] cannot read forwarded file ${file.name ?? file.id}`, error);
          return null;
        });
        if (info?.file) file = { ...file, ...(info.file as SlackFile) };
      }
      const url = file.url_private_download;
      if (!url) continue;
      result.push({
        name: file.name ?? file.id,
        mimeType: file.mimetype ?? "application/octet-stream",
        sizeBytes: file.size ?? 0,
        download: () => this.downloadFile(url),
      });
    }
    return result;
  }

  private async userName(userId: string) {
    const cached = this.userNames.get(userId);
    if (cached !== undefined) return cached;
    try {
      const info = await this.web.users.info({ user: userId });
      const name =
        info.user?.profile?.display_name || info.user?.real_name || info.user?.name || userId;
      this.userNames.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private async downloadFile(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.tokens.botToken}` },
    });
    if (!response.ok) throw new Error(`Slack file download failed with ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // ── outbound ────────────────────────────────────────────────────────────

  async reply(message: InboundMessage, text: string): Promise<void> {
    await this.web.chat.postMessage({
      channel: message.conversation.id,
      text,
      ...(message.isDirect && !this.threaded
        ? {}
        : { thread_ts: message.replyTo?.ts ?? message.ref.ts! }),
    });
  }

  async setThreadTitle(conversation: ConversationRef, title: string): Promise<void> {
    if (!this.threaded || conversation.threadTs === undefined) return;
    await this.web
      .apiCall("agents.sessions.rename", {
        channel_id: conversation.id,
        thread_ts: conversation.threadTs,
        title: title.slice(0, 200),
      })
      .catch((error: unknown) => this.log.warn(`[${this.name}] naming the thread`, error));
  }

  async openDirect(userId: string): Promise<ConversationRef> {
    const opened = await this.web.conversations.open({ users: userId });
    const id = opened.channel?.id;
    if (!id) throw new Error("Slack did not open a direct message");
    return { id, label: "Direct message" };
  }

  async setRunStatus(
    message: MessageRef,
    status: RunStatus,
    previous: RunStatus | null,
    sessionThreadTs?: string,
  ): Promise<void> {
    const channel = message.channel;
    const timestamp = message.ts;
    if (!channel || !timestamp) return;
    if (previous !== null && previous !== status) {
      await this.web.reactions
        .remove({ channel, timestamp, name: RUN_REACTIONS[previous] })
        .catch(() => {});
    }
    await this.web.reactions
      .add({ channel, timestamp, name: RUN_REACTIONS[status] })
      .catch((error: unknown) => {
        if (slackErrorCode(error) !== "already_reacted") throw error;
      });
    await this.setWorking(channel, sessionThreadTs ?? timestamp, status === "running");
  }

  /**
   * Shows Slack's "<bot> is working…" indicator under the message that started a run. Newer
   * workspaces take agents.sessions.setStatus; older ones the assistant thread status, which
   * Slack clears after two minutes, so it is refreshed while the run lasts.
   */
  private async setWorking(channel: string, threadTs: string, working: boolean) {
    const key = `${channel}:${threadTs}`;
    clearInterval(this.statusRefresh.get(key));
    this.statusRefresh.delete(key);
    if (this.sessionStatus === "agents") {
      try {
        await this.web.apiCall("agents.sessions.setStatus", {
          channel_id: channel,
          thread_ts: threadTs,
          status: working ? "processing" : "active",
        });
        return;
      } catch (error) {
        if (!isUnsupported(error)) return this.log.warn(`[${this.name}] working status`, error);
        this.sessionStatus = "assistant";
      }
    }
    if (this.sessionStatus !== "assistant") return;
    const set = (status: string) =>
      this.web.apiCall("assistant.threads.setStatus", {
        channel_id: channel,
        thread_ts: threadTs,
        status,
      });
    try {
      await set(working ? "is working…" : "");
      if (working) {
        const timer = setInterval(() => void set("is working…").catch(() => {}), 90_000);
        timer.unref();
        this.statusRefresh.set(key, timer);
        // A run that never reports back must not refresh forever.
        setTimeout(() => {
          clearInterval(timer);
          this.statusRefresh.delete(key);
        }, 60 * 60_000).unref();
      }
    } catch (error) {
      if (isUnsupported(error)) this.sessionStatus = null;
    }
  }

  async upsert(
    conversation: ConversationRef,
    post: OutboundPost,
    existing: MessageRef | null,
  ): Promise<MessageRef> {
    if (post.kind === "question")
      this.questions.set(`${post.threadId}:${post.requestId}`, post.questions);
    if (post.kind === "html") return existing ?? (await this.postHtml(conversation, post));
    if (
      post.kind === "assistant" &&
      this.threaded &&
      !this.streamingRejected &&
      conversation.threadTs !== undefined &&
      (existing === null ? post.streaming : existing.stream === "open")
    ) {
      const streamed = await this.stream(conversation, post, existing);
      if (streamed !== null) return streamed;
    }

    const chunks =
      post.kind === "assistant" || post.kind === "echo" || post.kind === "plan"
        ? splitSlackMarkdown(post.markdown)
        : [undefined];
    // While streaming only the first chunk is shown; the rest follow once the message is complete.
    const streaming = post.kind === "assistant" && post.streaming;
    if (
      post.kind === "assistant" &&
      !post.streaming &&
      post.markdown.length > CANVAS_THRESHOLD &&
      !this.canvasesRejected
    ) {
      const canvas = await this.publishCanvas(
        conversation,
        post.markdown,
        existing?.canvas ?? null,
      );
      if (canvas !== null) return this.postCanvasPreview(conversation, post, existing, canvas);
    }
    const first: Content = { ...renderPost(post, chunks[0]), kind: post.kind };
    const ref: Record<string, string> = { ...existing };
    if (existing?.ts) {
      await this.edit(existing.channel!, existing.ts, first);
    } else {
      const posted = await this.send(threadTarget(conversation), first);
      ref.channel = posted.channel ?? conversation.id;
      ref.ts = posted.ts ?? "";
      if (conversation.threadTs !== undefined) ref.thread = conversation.threadTs;
    }

    // The main message is posted now; a failed follow-up must not make the caller post it again.
    try {
      await this.postFollowUps(ref, post, chunks, streaming);
    } catch (error) {
      this.log.warn(`[${this.name}] follow-up for ${post.kind} failed`, error);
    }
    return ref;
  }

  private async postFollowUps(
    ref: Record<string, string>,
    post: OutboundPost,
    chunks: ReadonlyArray<string | undefined>,
    streaming: boolean,
  ) {
    if (!streaming) await this.postContinuations(ref, post, chunks.slice(1));
    if (
      post.kind === "assistant" &&
      !post.streaming &&
      post.images.length > 0 &&
      ref.images !== "done"
    ) {
      await this.uploadImages(ref.channel!, post.images, ref.thread);
      ref.images = "done";
    }
  }

  /**
   * Streams a reply with Slack's native streaming, which types it out in the thread. T3
   * resends the whole text each time, so only the part past what was already streamed is
   * appended. Returns null to fall back to posting and editing a normal message.
   */
  private async stream(
    conversation: ConversationRef,
    post: Extract<OutboundPost, { kind: "assistant" }>,
    existing: MessageRef | null,
  ): Promise<MessageRef | null> {
    const ref: Record<string, string> = { ...existing };
    try {
      if (existing === null) {
        const isChannel = !conversation.id.startsWith("D");
        const started = (await this.web.apiCall("chat.startStream", {
          channel: conversation.id,
          thread_ts: conversation.threadTs,
          markdown_text: post.markdown.slice(0, STREAM_CHUNK_LIMIT) || " ",
          ...(isChannel && conversation.meta?.user
            ? {
                recipient_user_id: conversation.meta.user,
                recipient_team_id: conversation.meta.team,
              }
            : {}),
        })) as { channel?: string; ts?: string };
        ref.channel = started.channel ?? conversation.id;
        ref.ts = started.ts ?? "";
        ref.thread = conversation.threadTs!;
        ref.stream = "open";
        this.streamed.set(ref.ts, post.markdown.slice(0, STREAM_CHUNK_LIMIT));
      } else {
        const sent = this.streamed.get(ref.ts!);
        // After a restart, or if the agent rewrote earlier text, the stream cannot be continued.
        if (sent === undefined || !post.markdown.startsWith(sent)) {
          await this.closeStream(ref);
          return null;
        }
        for (let at = sent.length; at < post.markdown.length; at += STREAM_CHUNK_LIMIT) {
          await this.web.apiCall("chat.appendStream", {
            channel: ref.channel,
            ts: ref.ts,
            markdown_text: post.markdown.slice(at, at + STREAM_CHUNK_LIMIT),
          });
        }
        this.streamed.set(ref.ts!, post.markdown);
      }
      if (!post.streaming) await this.finishStream(ref, post);
      return ref;
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "stopped_by_user" || code === "message_not_in_streaming_state") {
        await this.closeStream(ref);
        return ref;
      }
      if (existing === null) {
        if (isUnsupported(error) || code === "missing_recipient_team_id")
          this.streamingRejected = true;
        this.log.warn(
          `[${this.name}] streaming unavailable (${code ?? "error"}); posting normally`,
          error,
        );
        return null;
      }
      throw error;
    }
  }

  private async finishStream(
    ref: Record<string, string>,
    post: Extract<OutboundPost, { kind: "assistant" }>,
  ) {
    await this.closeStream(ref);
    // The streamed text stays in the thread; a long report also goes into a canvas.
    if (post.markdown.length > CANVAS_THRESHOLD && !this.canvasesRejected) {
      const canvas = await this.publishCanvas({ id: ref.channel!, label: "" }, post.markdown, null);
      if (canvas !== null) {
        ref.canvas = canvas.id;
        await this.send(
          { channel: ref.channel!, thread_ts: ref.thread! },
          {
            text: `Full report: ${canvas.title}`,
            blocks: [
              {
                type: "markdown",
                text: `📄 **Full report:** ${canvas.url ? `[${canvas.title}](${canvas.url})` : canvas.title}`,
              },
            ],
          },
        );
      }
    }
    if (post.images.length > 0 && ref.images !== "done") {
      await this.uploadImages(ref.channel!, post.images, ref.thread);
      ref.images = "done";
    }
  }

  private async closeStream(ref: Record<string, string>) {
    if (ref.stream === "open") {
      await this.web
        .apiCall("chat.stopStream", { channel: ref.channel, ts: ref.ts })
        .catch(() => {});
    }
    ref.stream = "done";
    this.streamed.delete(ref.ts!);
  }

  /**
   * Long reports read better as a Slack canvas than as a wall of messages. The canvas is shared
   * with the conversation it belongs to; its link and a short preview go to chat.
   */
  private async publishCanvas(
    conversation: ConversationRef,
    markdown: string,
    existingId: string | null,
  ): Promise<{ id: string; url: string; title: string } | null> {
    const title = reportTitle(markdown);
    try {
      let id = existingId;
      if (id === null) {
        const created = (await this.web.apiCall("canvases.create", {
          title,
          document_content: { type: "markdown", markdown },
        })) as { canvas_id?: string };
        if (!created.canvas_id) return null;
        id = created.canvas_id;
        await this.shareCanvas(id, conversation.id);
      } else {
        await this.web.apiCall("canvases.edit", {
          canvas_id: id,
          changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
        });
      }
      const info = (await this.web.files.info({ file: id })) as { file?: { permalink?: string } };
      return { id, url: info.file?.permalink ?? "", title };
    } catch (error) {
      const code = slackErrorCode(error);
      if (
        code === "missing_scope" ||
        code === "free_teams_cannot_create_standalone_canvases" ||
        code === "canvas_disabled_user_team" ||
        code === "restricted_action" ||
        code === "not_allowed_token_type"
      ) {
        this.canvasesRejected = true;
      }
      this.log.warn(
        `[${this.name}] canvas unavailable (${code ?? "error"}); posting the reply in chat`,
        error,
      );
      return null;
    }
  }

  /** Shares with the conversation; a direct message is shared with the person in it instead. */
  private async shareCanvas(canvasId: string, channel: string) {
    try {
      await this.web.apiCall("canvases.access.set", {
        canvas_id: canvasId,
        access_level: "read",
        channel_ids: [channel],
      });
    } catch (error) {
      const info = await this.web.conversations.info({ channel }).catch(() => null);
      const user = (info?.channel as { user?: string } | undefined)?.user;
      if (user === undefined) throw error;
      await this.web.apiCall("canvases.access.set", {
        canvas_id: canvasId,
        access_level: "read",
        user_ids: [user],
      });
    }
  }

  private async postCanvasPreview(
    conversation: ConversationRef,
    post: Extract<OutboundPost, { kind: "assistant" }>,
    existing: MessageRef | null,
    canvas: { id: string; url: string; title: string },
  ): Promise<MessageRef> {
    const preview = reportPreview(post.markdown);
    const link = canvas.url ? `[${canvas.title}](${canvas.url})` : canvas.title;
    const content = {
      text: notificationText(preview),
      blocks: [{ type: "markdown", text: `${preview}\n\n📄 **Full report:** ${link}` }] as Block[],
    };
    const ref: Record<string, string> = { ...existing, canvas: canvas.id };
    if (existing?.ts) {
      await this.edit(existing.channel!, existing.ts, content);
    } else {
      const posted = await this.send(threadTarget(conversation), content);
      if (conversation.threadTs !== undefined) ref.thread = conversation.threadTs;
      ref.channel = posted.channel ?? conversation.id;
      ref.ts = posted.ts ?? "";
    }
    // Continuation messages from the streaming draft are now in the canvas instead.
    await this.postContinuations(ref, post, []);
    if (post.images.length > 0 && ref.images !== "done") {
      await this.uploadImages(ref.channel!, post.images, ref.thread).catch(() => {});
      ref.images = "done";
    }
    return ref;
  }

  /**
   * Posts the richest layout Slack accepts. A post can carry simpler alternatives (a plan
   * becomes task cards, task cards become plain text); when Slack rejects one with
   * invalid_blocks the next is tried, and that choice is remembered for the kind of post.
   * Markdown blocks fall back to classic mrkdwn sections the same way.
   */
  private variants(content: Content): Block[][] {
    const all = [content.blocks, ...(content.fallbacks ?? [])];
    const from = Math.min(this.blockLevel.get(content.kind ?? "") ?? 0, all.length - 1);
    const chosen = all.slice(from);
    const last = chosen.at(-1)!;
    const plain = withoutMarkdownBlocks(last);
    return JSON.stringify(plain) === JSON.stringify(last) ? chosen : [...chosen, plain];
  }

  private async withVariants<T>(
    content: Content,
    attempt: (blocks: Block[]) => Promise<T>,
  ): Promise<T> {
    const variants = this.variants(content);
    for (const [index, blocks] of variants.entries()) {
      try {
        return await attempt(blocks);
      } catch (error) {
        if (slackErrorCode(error) !== "invalid_blocks" || index === variants.length - 1)
          throw error;
        if (content.kind !== undefined && index < (content.fallbacks?.length ?? 0)) {
          const level = (this.blockLevel.get(content.kind) ?? 0) + 1;
          this.blockLevel.set(content.kind, level);
          this.log.warn(
            `[${this.name}] Slack rejected the ${content.kind} layout; using a simpler one`,
          );
        }
      }
    }
    throw new Error("unreachable");
  }

  private async send(target: { channel: string; thread_ts?: string }, content: Content) {
    return this.withVariants(content, (blocks) =>
      this.web.chat.postMessage({
        ...target,
        text: content.text,
        blocks: blocks as never,
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
  }

  private async edit(channel: string, ts: string, content: Content) {
    return this.withVariants(content, (blocks) =>
      this.web.chat.update({ channel, ts, text: content.text, blocks: blocks as never }),
    );
  }

  /** Extra messages for markdown past the first block; edited in place if the text changes again. */
  private async postContinuations(
    ref: Record<string, string>,
    post: OutboundPost,
    rest: ReadonlyArray<string | undefined>,
  ) {
    const existing = ref.more ? ref.more.split(",") : [];
    const next: string[] = [];
    for (const [index, chunk] of rest.entries()) {
      if (chunk === undefined) continue;
      const rendered = renderPost(post, chunk);
      const ts = existing[index];
      if (ts) {
        await this.edit(ref.channel!, ts, rendered);
        next.push(ts);
      } else {
        const posted = await this.send(
          { channel: ref.channel!, ...(ref.thread ? { thread_ts: ref.thread } : {}) },
          rendered,
        );
        next.push(posted.ts ?? "");
      }
    }
    for (const stale of existing.slice(rest.length)) {
      await this.web.chat.delete({ channel: ref.channel!, ts: stale }).catch(() => {});
    }
    if (next.length > 0) ref.more = next.join(",");
    else delete ref.more;
  }

  private async uploadImages(channel: string, images: ReadonlyArray<ImageRef>, threadTs?: string) {
    for (const image of images) {
      try {
        const loaded = await image.load();
        await this.web.filesUploadV2({
          channel_id: channel,
          file: loaded.bytes,
          filename: image.name,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        } as never);
      } catch (error) {
        this.log.warn(`[${this.name}] uploading ${image.name} failed`, error);
      }
    }
  }

  private async postHtml(
    conversation: ConversationRef,
    post: Extract<OutboundPost, { kind: "html" }>,
  ) {
    let file: Buffer;
    try {
      file = (await post.html.load()).bytes;
    } catch (error) {
      this.log.warn(`[${this.name}] preparing ${post.html.name} failed`, error);
      const posted = await this.web.chat.postMessage({
        ...threadTarget(conversation),
        text: `🖼 ${post.title} (open it in T3)`,
      });
      return { channel: posted.channel ?? conversation.id, ts: posted.ts ?? "" };
    }
    await this.web.filesUploadV2({
      channel_id: conversation.id,
      ...(conversation.threadTs === undefined ? {} : { thread_ts: conversation.threadTs }),
      initial_comment: `🖼 *${post.title}*`,
      file_uploads: [{ file, filename: post.html.name }],
    } as never);
    return { channel: conversation.id, uploaded: "1" };
  }
}

function sharedMessages(attachments: SlackSharedMessage[] | undefined): SlackSharedMessage[] {
  return (attachments ?? []).filter(
    (attachment) =>
      attachment.is_share === true ||
      attachment.is_msg_unfurl === true ||
      attachment.message_blocks !== undefined ||
      (attachment.files?.length ?? 0) > 0,
  );
}

function sharedFiles(shared: SlackSharedMessage): SlackFile[] {
  return [
    ...(shared.files ?? []),
    ...(shared.message_blocks ?? []).flatMap((block) => block.message?.files ?? []),
  ];
}

/** Where a new post goes: the conversation, inside its thread when it has one. */
function threadTarget(conversation: ConversationRef): { channel: string; thread_ts?: string } {
  return conversation.threadTs === undefined
    ? { channel: conversation.id }
    : { channel: conversation.id, thread_ts: conversation.threadTs };
}

/** Slack escapes &, < and > in message text; the agent should see what the person typed. */
function decodeSlackText(text: string) {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Errors that mean this workspace or app cannot use a method at all, as opposed to a blip. */
function isUnsupported(error: unknown) {
  const code = slackErrorCode(error);
  return (
    code === "feature_disabled" ||
    // Slack answers this when the app is not set up as an agent (no agent view).
    code === "not_authorized" ||
    code === "unknown_method" ||
    code === "method_not_supported_for_channel_type" ||
    code === "missing_scope" ||
    code === "not_allowed_token_type" ||
    code === "method_deprecated" ||
    code === "deprecated_endpoint"
  );
}

export function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } })?.data?.error;
}
