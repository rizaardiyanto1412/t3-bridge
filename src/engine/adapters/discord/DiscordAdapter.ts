import { BUTTON_PREFIX, ButtonStore } from "../../core/ButtonStore.ts";
import {
  buttonInbound,
  LONG_REPLY,
  postText,
  RUN_EMOJI,
  safeFileName,
  STOP_EMOJI,
  type ChatButton,
} from "../../core/chatText.ts";
import { reportPreview, reportTitle, splitMarkdown, truncate } from "../../core/markdown.ts";
import {
  PlatformError,
  type AdapterHandlers,
  type ChatAdapter,
  type ConversationRef,
  type EarlierMessage,
  type ImageRef,
  type InboundFile,
  type InboundMessage,
  type MessageRef,
  type OutboundPost,
  type RunStatus,
} from "../../core/types.ts";
import type { Logger } from "../../log.ts";
import { BRIDGE_VERSION } from "../../version.ts";
import { decodeDiscordText, DISCORD_MESSAGE_LIMIT, toDiscordMarkdown } from "./format.ts";

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "?v=10&encoding=json";

const INTENT = {
  guilds: 1 << 0,
  guildMessages: 1 << 9,
  guildMessageReactions: 1 << 10,
  directMessages: 1 << 12,
  directMessageReactions: 1 << 13,
  messageContent: 1 << 15,
};
const BASE_INTENTS =
  INTENT.guilds |
  INTENT.guildMessages |
  INTENT.guildMessageReactions |
  INTENT.directMessages |
  INTENT.directMessageReactions;
/** Application flags saying the Message Content intent is turned on in the developer portal. */
const APP_FLAG_MESSAGE_CONTENT = (1 << 18) | (1 << 19);

/** Close codes after which reconnecting cannot help: bad token, bad intents and the like. */
const FATAL_CLOSE: Record<number, string> = {
  4004: "Discord rejected the bot token",
  4010: "Discord rejected the connection (invalid shard)",
  4011: "This bot is in too many servers to run without sharding",
  4012: "Discord rejected the connection (gateway version)",
  4013: "Discord rejected the connection (invalid intents)",
  4014: "Discord refused a privileged intent",
};

/** View channel, send messages (also in threads), embed links, attach files, read history, add reactions. */
const PERMISSIONS =
  (1n << 10n) | (1n << 11n) | (1n << 38n) | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 6n);

/** The link that adds the bot to a server; people can only DM a bot they share a server with. */
export function discordInviteUrl(applicationId: string) {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${PERMISSIONS}`;
}

/** Discord error codes that will not go away by retrying. */
const PERMANENT_CODES = new Set([10003, 10008, 50001, 50005, 50007, 50013, 50035]);

async function discordRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        "user-agent": `DiscordBot (https://github.com/rizaardiyanto1412/t3-bridge, ${BRIDGE_VERSION})`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined as T;
    const json = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: number;
      retry_after?: number;
    };
    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((json.retry_after ?? 1) * 1000)));
      continue;
    }
    if (!response.ok) {
      const permanent =
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404 ||
        (json.code !== undefined && PERMANENT_CODES.has(json.code));
      throw new PlatformError(
        `Discord: ${json.message ?? response.statusText} (${json.code ?? response.status})`,
        response.status,
        permanent,
      );
    }
    return json as T;
  }
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  author: DiscordUser;
  member?: { nick?: string | null };
  content: string;
  mentions?: Array<DiscordUser & { member?: { nick?: string | null } }>;
  attachments?: DiscordAttachment[];
  message_reference?: { type?: number; message_id?: string; channel_id?: string };
  message_snapshots?: Array<{ message: { content?: string; attachments?: DiscordAttachment[] } }>;
  embeds?: DiscordEmbed[];
  /** The message this one replies to, sent along with replies. */
  referenced_message?: DiscordMessage | null;
}

interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  fields?: Array<{ name: string; value: string }>;
  footer?: { text?: string };
}

interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  data?: { custom_id?: string };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
}

/** Checks a bot token before it is saved, and reads what the setup page needs to show. */
export async function testDiscordToken(input: { botToken: string }) {
  const token = String(input?.botToken ?? "").trim();
  if (token.length < 50 || /\s/.test(token))
    throw new Error("That does not look like a Discord bot token (Bot → Reset Token).");
  const me = await discordRequest<DiscordUser>(token, "GET", "/users/@me");
  const app = await discordRequest<{ id: string; flags?: number }>(
    token,
    "GET",
    "/applications/@me",
  );
  return {
    botUser: me.username,
    botUserId: me.id,
    applicationId: app.id,
    messageContent: ((app.flags ?? 0) & APP_FLAG_MESSAGE_CONTENT) !== 0,
    inviteUrl: discordInviteUrl(app.id),
  };
}

/**
 * Discord through its gateway WebSocket, so the bridge needs no public URL. Each bot is its
 * own Discord application with its own token. Replies are posted and then edited in place
 * while they stream; buttons answer approvals and questions.
 */
export class DiscordAdapter implements ChatAdapter {
  private handlers: AdapterHandlers | null = null;
  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private acked = true;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private intents = BASE_INTENTS;
  private attempt = 0;
  private stopped = false;
  private ready: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private botUserId = "";
  private applicationId = "";
  private identity = "";
  private readonly seen = new Set<string>();
  private readonly directChannels = new Map<string, string>();
  private readonly typing = new Map<string, NodeJS.Timeout>();

  private readonly token: string;
  private readonly log: Logger;
  private readonly name: string;
  private readonly buttons: ButtonStore;

  constructor(token: string, log: Logger, name: string, buttons: ButtonStore) {
    this.token = token;
    this.log = log;
    this.name = name;
    this.buttons = buttons;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return discordRequest<T>(this.token, method, path, body);
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    handlers.onStatus({ state: "connecting" });
    try {
      const me = await this.request<DiscordUser>("GET", "/users/@me");
      this.botUserId = me.id;
      this.identity = `${me.username} on Discord`;
      const app = await this.request<{ id: string; flags?: number }>("GET", "/applications/@me");
      this.applicationId = app.id;
      // Without the Message Content intent Discord still shows the bot DMs, mentions, and
      // replies that ping it, which is all a bot needs; with it, quiet replies work too.
      this.intents =
        BASE_INTENTS | (((app.flags ?? 0) & APP_FLAG_MESSAGE_CONTENT) !== 0 ? INTENT.messageContent : 0);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Discord did not answer in time")), 30_000);
        this.ready = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        this.connect();
      });
      handlers.onStatus({ state: "connected", identity: this.identity });
    } catch (error) {
      handlers.onStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }

  // ── gateway ─────────────────────────────────────────────────────────────

  private connect() {
    const resuming = this.sessionId !== null && this.resumeUrl !== null;
    const socket = new WebSocket(`${resuming ? this.resumeUrl : GATEWAY}${GATEWAY_QUERY}`);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      try {
        this.onPayload(JSON.parse(String(event.data)));
      } catch (error) {
        this.log.warn(`[${this.name}] Discord gateway message`, error);
      }
    });
    socket.addEventListener("close", (event) => {
      if (socket === this.socket) this.onClose(event.code);
    });
    socket.addEventListener("error", () => {});
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private onPayload(payload: { op: number; d: unknown; s: number | null; t: string | null }) {
    if (payload.s !== null && payload.s !== undefined) this.sequence = payload.s;
    switch (payload.op) {
      case 10:
        return this.onHello((payload.d as { heartbeat_interval: number }).heartbeat_interval);
      case 11:
        this.acked = true;
        return;
      case 1:
        return this.send({ op: 1, d: this.sequence });
      case 7:
        // Discord asks for a reconnect; 4000 keeps the session resumable.
        return this.socket?.close(4000);
      case 9:
        if (payload.d !== true) {
          this.sessionId = null;
          this.sequence = null;
        }
        return this.socket?.close(4000);
      case 0:
        return this.onDispatch(payload.t ?? "", payload.d);
    }
  }

  private onHello(interval: number) {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.acked = true;
    const beat = () => {
      // No answer to the last heartbeat: the connection is dead even if the socket looks open.
      if (!this.acked) return this.socket?.close(4000);
      this.acked = false;
      this.send({ op: 1, d: this.sequence });
    };
    this.heartbeat = setInterval(beat, interval);
    if (this.sessionId !== null) {
      this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } });
    } else {
      this.send({
        op: 2,
        d: {
          token: this.token,
          intents: this.intents,
          properties: { os: "macos", browser: "t3-bridge", device: "t3-bridge" },
        },
      });
    }
  }

  private onClose(code: number) {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.stopped) return;
    if (code === 4014 && (this.intents & INTENT.messageContent) !== 0) {
      this.log.warn(`[${this.name}] Discord refused the Message Content intent; continuing without it`);
      this.intents &= ~INTENT.messageContent;
    } else if (FATAL_CLOSE[code] !== undefined) {
      const error = new Error(FATAL_CLOSE[code]);
      if (this.ready !== null) this.ready.reject(error);
      else this.handlers?.onStatus({ state: "error", error: error.message });
      this.ready = null;
      return;
    }
    // Invalid sequence or a timed-out session cannot be resumed; start a new one.
    if (code === 4007 || code === 4009) {
      this.sessionId = null;
      this.sequence = null;
    }
    if (this.ready === null) this.handlers?.onStatus({ state: "connecting" });
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt) + Math.random() * 1000;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private onDispatch(type: string, data: unknown) {
    switch (type) {
      case "READY": {
        const ready = data as { session_id: string; resume_gateway_url: string };
        this.sessionId = ready.session_id;
        this.resumeUrl = ready.resume_gateway_url;
        this.markConnected();
        return;
      }
      case "RESUMED":
        this.markConnected();
        return;
      case "MESSAGE_CREATE":
        void this.onMessage(data as DiscordMessage).catch((error: unknown) =>
          this.log.error(`[${this.name}] Discord message`, error),
        );
        return;
      case "MESSAGE_REACTION_ADD": {
        const reaction = data as { user_id: string; emoji: { name?: string | null } };
        if (reaction.user_id !== this.botUserId && STOP_EMOJI.has(reaction.emoji.name ?? "")) {
          void this.handlers?.onAction({ type: "stop", userId: reaction.user_id });
        }
        return;
      }
      case "INTERACTION_CREATE":
        void this.onInteraction(data as DiscordInteraction).catch((error: unknown) =>
          this.log.error(`[${this.name}] Discord button`, error),
        );
        return;
    }
  }

  private markConnected() {
    this.attempt = 0;
    if (this.ready !== null) {
      this.ready.resolve();
      this.ready = null;
    } else {
      this.handlers?.onStatus({ state: "connected", identity: this.identity });
    }
  }

  // ── inbound ─────────────────────────────────────────────────────────────

  private async onMessage(message: DiscordMessage) {
    if (message.author.bot || message.author.id === this.botUserId) return;
    // Plain messages and replies; joins, pins and the like are not requests.
    if (message.type !== 0 && message.type !== 19) return;
    // A resumed session can replay events.
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (this.seen.size > 2000) for (const id of [...this.seen].slice(0, 1000)) this.seen.delete(id);

    const isDirect = message.guild_id === undefined;
    const names = new Map(
      (message.mentions ?? []).map((user) => [
        user.id,
        user.member?.nick ?? user.global_name ?? user.username,
      ]),
    );
    const mentionsBot =
      (message.mentions ?? []).some((user) => user.id === this.botUserId) ||
      new RegExp(`<@!?${this.botUserId}>`).test(message.content);
    const forwarded = message.message_reference?.type === 1;
    const quoted = (message.message_snapshots ?? []).map((snapshot) => {
      const body = (snapshot.message.content ?? "").trim() || "(no text)";
      return ["Forwarded message:", ...body.split("\n").map((line) => `> ${line}`)].join("\n");
    });
    const inbound: InboundMessage = {
      conversation: {
        id: message.channel_id,
        label: isDirect ? "Direct message" : `<#${message.channel_id}>`,
      },
      ref: { channel: message.channel_id, ts: message.id },
      userId: message.author.id,
      userName: message.member?.nick ?? message.author.global_name ?? message.author.username,
      isDirect,
      mentionsBot,
      text: [decodeDiscordText(message.content, names, this.botUserId), ...quoted]
        .filter(Boolean)
        .join("\n\n"),
      files: [
        ...(message.attachments ?? []),
        ...(message.message_snapshots ?? []).flatMap((snapshot) => snapshot.message.attachments ?? []),
      ].map(inboundFile),
      replyTo:
        !forwarded && message.message_reference?.message_id
          ? {
              channel: message.message_reference.channel_id ?? message.channel_id,
              ts: message.message_reference.message_id,
            }
          : null,
      ...(!forwarded && message.referenced_message
        ? { earlier: async () => [earlierMessage(message.referenced_message!)] }
        : {}),
    };
    await this.handlers?.onMessage(inbound);
  }

  private async onInteraction(interaction: DiscordInteraction) {
    if (interaction.type !== 3) return;
    const customId = interaction.data?.custom_id ?? "";
    const userId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
    // Acknowledge at once (Discord allows three seconds); the post updates when T3 resolves.
    await this.request("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, {
      type: 6,
    });
    if (!customId.startsWith(BUTTON_PREFIX)) return;
    const action = await this.buttons.get(customId.slice(BUTTON_PREFIX.length));
    if (action === null) {
      await this.request("POST", `/webhooks/${this.applicationId}/${interaction.token}`, {
        content: "This button no longer works. Reply to the message instead.",
        flags: 64,
      });
      return;
    }
    await this.handlers?.onAction(buttonInbound(action, userId));
  }

  // ── outbound ────────────────────────────────────────────────────────────

  async reply(message: InboundMessage, text: string): Promise<void> {
    await this.request("POST", `/channels/${message.conversation.id}/messages`, {
      content: truncate(text, 2000),
      message_reference: { message_id: message.ref.ts, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    });
  }

  async openDirect(userId: string): Promise<ConversationRef> {
    let id = this.directChannels.get(userId);
    if (id === undefined) {
      id = (await this.request<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId })).id;
      this.directChannels.set(userId, id);
    }
    return { id, label: "Direct message" };
  }

  async setRunStatus(message: MessageRef, status: RunStatus, previous: RunStatus | null): Promise<void> {
    const channel = message.channel;
    const id = message.ts;
    if (!channel || !id) return;
    const path = (emoji: string) =>
      `/channels/${channel}/messages/${id}/reactions/${encodeURIComponent(emoji)}/@me`;
    if (previous !== null && previous !== status) {
      await this.request("DELETE", path(RUN_EMOJI[previous])).catch(() => {});
    }
    await this.request("PUT", path(RUN_EMOJI[status]));
    this.setTyping(channel, id, status === "running");
  }

  /** "<bot> is typing…" lasts ten seconds, so it is renewed while the run lasts, for an hour at most. */
  private setTyping(channel: string, messageId: string, working: boolean) {
    const key = `${channel}:${messageId}`;
    clearInterval(this.typing.get(key));
    this.typing.delete(key);
    if (!working) return;
    const type = () => void this.request("POST", `/channels/${channel}/typing`).catch(() => {});
    type();
    const timer = setInterval(type, 8000);
    timer.unref();
    this.typing.set(key, timer);
    setTimeout(() => {
      clearInterval(timer);
      if (this.typing.get(key) === timer) this.typing.delete(key);
    }, 60 * 60_000).unref();
  }

  async upsert(
    conversation: ConversationRef,
    post: OutboundPost,
    existing: MessageRef | null,
  ): Promise<MessageRef> {
    if (post.kind === "html") return existing ?? (await this.postHtml(conversation, post));
    const text = postText(post);
    const streaming = post.kind === "assistant" && post.streaming;
    const long = post.kind === "assistant" && !post.streaming && post.markdown.length > LONG_REPLY;
    const title = long ? reportTitle(post.markdown) : "";
    const body = long
      ? `${reportPreview(post.markdown)}\n\n📄 **Full reply attached:** ${title}`
      : text.markdown;
    let chunks = splitMarkdown(toDiscordMarkdown(body), DISCORD_MESSAGE_LIMIT);
    // While streaming only the first chunk is shown; the rest follow once the message is complete.
    if (streaming) chunks = [`${chunks[0]}\n-# ✍️ writing…`];
    const payload = {
      content: chunks[0]!.trim() || "🖼",
      components: await this.components(text.buttons),
      allowed_mentions: { parse: [] },
    };
    const ref: Record<string, string> = { ...existing };
    if (existing?.ts) {
      await this.request("PATCH", `/channels/${existing.channel}/messages/${existing.ts}`, payload);
    } else {
      const posted = await this.request<{ id: string; channel_id: string }>(
        "POST",
        `/channels/${conversation.id}/messages`,
        payload,
      );
      ref.channel = posted.channel_id;
      ref.ts = posted.id;
    }
    // The main message is posted now; a failed follow-up must not make the caller post it again.
    try {
      if (!streaming) await this.postContinuations(ref, chunks.slice(1));
      if (long && ref.report !== "done") {
        await this.uploadFiles(ref.channel!, "", [
          { name: `${safeFileName(title)}.md`, bytes: Buffer.from(post.markdown), mimeType: "text/markdown" },
        ]);
        ref.report = "done";
      }
      if (post.kind === "assistant" && !streaming && post.images.length > 0 && ref.images !== "done") {
        await this.uploadImages(ref.channel!, post.images);
        ref.images = "done";
      }
    } catch (error) {
      this.log.warn(`[${this.name}] follow-up for ${post.kind} failed`, error);
    }
    return ref;
  }

  /** Buttons as Discord components: up to five rows of five. */
  private async components(rows: ReadonlyArray<ReadonlyArray<ChatButton>>) {
    const styles = { primary: 1, secondary: 2, danger: 4 } as const;
    return Promise.all(
      rows.slice(0, 5).map(async (row) => ({
        type: 1,
        components: await Promise.all(
          row.slice(0, 5).map(async (button) => ({
            type: 2,
            style: styles[button.style],
            label: truncate(button.label, 80),
            custom_id: `${BUTTON_PREFIX}${await this.buttons.put(button.action)}`,
          })),
        ),
      })),
    );
  }

  /** Extra messages for text past the first; edited in place if the text changes again. */
  private async postContinuations(ref: Record<string, string>, rest: ReadonlyArray<string>) {
    const existing = ref.more ? ref.more.split(",") : [];
    const next: string[] = [];
    for (const [index, chunk] of rest.entries()) {
      const payload = { content: chunk, allowed_mentions: { parse: [] } };
      const id = existing[index];
      if (id) {
        await this.request("PATCH", `/channels/${ref.channel}/messages/${id}`, payload);
        next.push(id);
      } else {
        next.push(
          (await this.request<{ id: string }>("POST", `/channels/${ref.channel}/messages`, payload)).id,
        );
      }
    }
    for (const stale of existing.slice(rest.length)) {
      await this.request("DELETE", `/channels/${ref.channel}/messages/${stale}`).catch(() => {});
    }
    if (next.length > 0) ref.more = next.join(",");
    else delete ref.more;
  }

  private async uploadImages(channel: string, images: ReadonlyArray<ImageRef>) {
    const files: Array<{ name: string; bytes: Buffer; mimeType: string }> = [];
    for (const image of images) {
      try {
        files.push({ name: image.name, ...(await image.load()) });
      } catch (error) {
        this.log.warn(`[${this.name}] loading ${image.name} failed`, error);
      }
    }
    // Discord takes up to ten files per message.
    for (let start = 0; start < files.length; start += 10) {
      await this.uploadFiles(channel, "", files.slice(start, start + 10));
    }
  }

  private async uploadFiles(
    channel: string,
    content: string,
    files: ReadonlyArray<{ name: string; bytes: Buffer; mimeType: string }>,
  ) {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
        attachments: files.map((file, index) => ({ id: index, filename: file.name })),
      }),
    );
    files.forEach((file, index) =>
      form.append(`files[${index}]`, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name),
    );
    return this.request<{ id: string; channel_id: string }>("POST", `/channels/${channel}/messages`, form);
  }

  private async postHtml(conversation: ConversationRef, post: Extract<OutboundPost, { kind: "html" }>) {
    try {
      const loaded = await post.html.load();
      const posted = await this.uploadFiles(conversation.id, `🖼 **${post.title}**`, [
        { name: post.html.name, ...loaded },
      ]);
      return { channel: posted.channel_id, ts: posted.id };
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      this.log.warn(`[${this.name}] preparing ${post.html.name} failed`, error);
      const posted = await this.request<{ id: string; channel_id: string }>(
        "POST",
        `/channels/${conversation.id}/messages`,
        { content: `🖼 ${post.title} (open it in T3)` },
      );
      return { channel: posted.channel_id, ts: posted.id };
    }
  }
}

/** A replied-to message, with what other bots put in embeds (alerts usually do). */
function earlierMessage(message: DiscordMessage): EarlierMessage {
  const embeds = (message.embeds ?? []).flatMap((embed) => [
    embed.title && embed.url ? `${embed.title} (${embed.url})` : embed.title,
    embed.description,
    ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`),
    embed.footer?.text,
  ]);
  return {
    author: message.member?.nick ?? message.author.global_name ?? message.author.username,
    text: [message.content, ...embeds].filter((part) => part?.trim()).join("\n"),
    files: (message.attachments ?? []).map(inboundFile),
  };
}

function inboundFile(attachment: DiscordAttachment): InboundFile {
  return {
    name: attachment.filename,
    mimeType: attachment.content_type?.split(";")[0] ?? "application/octet-stream",
    sizeBytes: attachment.size,
    download: async () => {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`Discord file download failed with ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
