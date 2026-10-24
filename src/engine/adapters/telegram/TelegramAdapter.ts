import { BUTTON_PREFIX, ButtonStore } from "../../core/ButtonStore.ts";
import {
  buttonInbound,
  LONG_REPLY,
  plainText,
  postText,
  safeFileName,
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
import { TELEGRAM_MESSAGE_LIMIT, toTelegramHtml } from "./format.ts";

const API = "https://api.telegram.org";
/** Bots can download files up to 20 MB through the Bot API. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Telegram only takes reactions from a fixed set; ✅ and ❌ are not in it. */
const RUN_REACTIONS: Record<RunStatus, string> = {
  running: "👀",
  completed: "👍",
  failed: "👎",
  interrupted: "🤷",
};
/** Album photos arrive one message each; they are gathered into one request. */
const ALBUM_WAIT_MS = 1200;

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

interface TelegramFileInfo {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  media_group_id?: string;
  /** The whole replied-to message, as Telegram sends it with a reply. */
  reply_to_message?: TelegramMessage;
  forward_origin?: {
    type: "user" | "hidden_user" | "chat" | "channel";
    sender_user?: TelegramUser;
    sender_user_name?: string;
    sender_chat?: TelegramChat;
    chat?: TelegramChat;
  };
  photo?: Array<TelegramFileInfo & { width: number; height: number }>;
  document?: TelegramFileInfo;
  video?: TelegramFileInfo;
  audio?: TelegramFileInfo;
  voice?: TelegramFileInfo;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
  };
}

async function telegramRequest<T>(
  token: string,
  method: string,
  params: Record<string, unknown> | FormData = {},
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      ...(params instanceof FormData
        ? { body: params }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }),
      ...(signal ? { signal } : {}),
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (json.ok) return json.result as T;
    const status = json.error_code ?? response.status;
    if (status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, (json.parameters?.retry_after ?? 1) * 1000));
      continue;
    }
    const description = json.description ?? response.statusText;
    const permanent =
      status === 401 ||
      status === 403 ||
      /chat not found|message to edit not found|message can't be edited|not enough rights/i.test(description);
    throw new PlatformError(`Telegram: ${description}`, status, permanent);
  }
}

/** Checks a bot token from @BotFather before it is saved. */
export async function testTelegramToken(input: { botToken: string }) {
  const token = String(input?.botToken ?? "").trim();
  if (!/^\d+:[\w-]{30,}$/.test(token))
    throw new Error("That does not look like a Telegram bot token (123456:ABC…, from @BotFather).");
  const me = await telegramRequest<TelegramUser & { can_read_all_group_messages?: boolean }>(
    token,
    "getMe",
  );
  return {
    botUser: me.username ?? me.first_name,
    botUserId: String(me.id),
    link: `https://t.me/${me.username ?? ""}`,
  };
}

/**
 * Telegram through long polling (getUpdates), so the bridge needs no public URL. Each bot is
 * its own @BotFather bot with its own token. Replies are posted and then edited in place
 * while they stream; inline buttons answer approvals and questions.
 */
export class TelegramAdapter implements ChatAdapter {
  private handlers: AdapterHandlers | null = null;
  private polling: AbortController | null = null;
  private offset = 0;
  private botUserId = 0;
  private username = "";
  private identity = "";
  private readonly typing = new Map<string, NodeJS.Timeout>();
  private readonly albums = new Map<string, { messages: TelegramMessage[]; timer: NodeJS.Timeout }>();

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

  private request<T>(method: string, params?: Record<string, unknown> | FormData, signal?: AbortSignal) {
    return telegramRequest<T>(this.token, method, params, signal);
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    handlers.onStatus({ state: "connecting" });
    try {
      const me = await this.request<TelegramUser>("getMe");
      this.botUserId = me.id;
      this.username = me.username ?? "";
      this.identity = `@${this.username} on Telegram`;
      // Long polling does not work while a webhook is set, e.g. by another tool.
      await this.request("deleteWebhook", { drop_pending_updates: false });
      await this.request("setMyCommands", {
        commands: [
          { command: "stop", description: "Stop the agent" },
          { command: "new", description: "Start a fresh orchestrator thread" },
        ],
      }).catch((error: unknown) => this.log.warn(`[${this.name}] setting Telegram commands`, error));
    } catch (error) {
      handlers.onStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    handlers.onStatus({ state: "connected", identity: this.identity });
    const controller = new AbortController();
    this.polling = controller;
    void this.poll(controller.signal);
  }

  async stop(): Promise<void> {
    this.polling?.abort();
    this.polling = null;
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    for (const album of this.albums.values()) clearTimeout(album.timer);
    this.albums.clear();
  }

  private async poll(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.request<TelegramUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: 50, allowed_updates: ["message", "callback_query"] },
          signal,
        );
        if (failures > 0) this.handlers?.onStatus({ state: "connected", identity: this.identity });
        failures = 0;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          void this.onUpdate(update).catch((error: unknown) =>
            this.log.error(`[${this.name}] Telegram update`, error),
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        const conflict = error instanceof PlatformError && error.status === 409;
        this.handlers?.onStatus({
          state: "error",
          error: conflict
            ? "Another program is reading this bot's messages. Stop it, or give this bot its own token."
            : error instanceof Error
              ? error.message
              : String(error),
        });
        if (error instanceof PlatformError && error.status === 401) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2000 * 2 ** failures)));
      }
    }
  }

  // ── inbound ─────────────────────────────────────────────────────────────

  private async onUpdate(update: TelegramUpdate) {
    if (update.callback_query !== undefined) return this.onButton(update.callback_query);
    const message = update.message;
    if (message === undefined || message.from === undefined || message.from.is_bot) return;
    if (message.media_group_id !== undefined) return this.gatherAlbum(message);
    await this.deliver([message]);
  }

  private gatherAlbum(message: TelegramMessage) {
    const key = `${message.chat.id}:${message.media_group_id}`;
    const album = this.albums.get(key);
    if (album !== undefined) clearTimeout(album.timer);
    const messages = [...(album?.messages ?? []), message];
    const timer = setTimeout(() => {
      this.albums.delete(key);
      void this.deliver(messages).catch((error: unknown) =>
        this.log.error(`[${this.name}] Telegram album`, error),
      );
    }, ALBUM_WAIT_MS);
    this.albums.set(key, { messages, timer });
  }

  /** One request from a message, or from all the messages of an album. */
  private async deliver(messages: ReadonlyArray<TelegramMessage>) {
    const first = messages[0]!;
    const from = first.from!;
    const chatId = String(first.chat.id);
    const isDirect = first.chat.type === "private";
    let mentionsBot = false;
    const texts: string[] = [];
    for (const message of messages) {
      const parsed = this.readText(message);
      mentionsBot ||= parsed.mentionsBot;
      if (parsed.text) texts.push(parsed.text);
    }
    const files: InboundFile[] = [];
    for (const message of messages) {
      for (const file of messageFiles(message)) {
        if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
          await this.request("sendMessage", {
            chat_id: first.chat.id,
            text: `⚠️ ${file.name} is too large for a Telegram bot to download (20 MB limit).`,
            reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
          }).catch(() => {});
          continue;
        }
        files.push({
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.file_size ?? 0,
          download: () => this.download(file.file_id),
        });
      }
    }
    // In a forum topic every message "replies" to the topic's first message; that is not a reply.
    const reply = first.reply_to_message;
    const isReply =
      reply !== undefined && !(first.is_topic_message && reply.message_id === first.message_thread_id);
    const topic = first.is_topic_message ? first.message_thread_id : undefined;
    const forwardedFrom = forwardSource(first);
    const text = texts.join("\n\n");
    await this.handlers?.onMessage({
      conversation: {
        id: chatId,
        label: isDirect ? "Direct message" : (first.chat.title ?? "Group"),
        ...(topic === undefined ? {} : { meta: { topic: String(topic) } }),
      },
      ref: {
        channel: chatId,
        ts: String(first.message_id),
        ...(topic === undefined ? {} : { topic: String(topic) }),
      },
      userId: String(from.id),
      userName: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id),
      isDirect,
      mentionsBot,
      text:
        forwardedFrom === null
          ? text
          : [`Forwarded message from ${forwardedFrom}:`, ...(text || "(no text)").split("\n").map((line) => `> ${line}`)].join("\n"),
      files,
      replyTo: isReply ? { channel: chatId, ts: String(reply.message_id) } : null,
      ...(isReply ? { earlier: async () => [this.earlierMessage(reply)] } : {}),
    });
  }

  private earlierMessage(message: TelegramMessage): EarlierMessage {
    const from = message.from;
    return {
      author: from
        ? [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "someone"
        : (message.chat.title ?? "someone"),
      text: message.text ?? message.caption ?? "",
      files: messageFiles(message)
        .filter((file) => (file.file_size ?? 0) <= MAX_DOWNLOAD_BYTES)
        .map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.file_size ?? 0,
          download: () => this.download(file.file_id),
        })),
    };
  }

  /** The text of a message without the bot's @name; commands lose their @bot suffix. */
  private readText(message: TelegramMessage): { text: string; mentionsBot: boolean } {
    const raw = message.text ?? message.caption ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];
    const handle = `@${this.username}`.toLowerCase();
    let mentionsBot = false;
    const cuts: Array<{ offset: number; length: number; replacement: string }> = [];
    for (const entity of entities) {
      const value = raw.slice(entity.offset, entity.offset + entity.length);
      if (entity.type === "mention" && value.toLowerCase() === handle) {
        mentionsBot = true;
        cuts.push({ ...entity, replacement: "" });
      } else if (entity.type === "text_mention" && entity.user?.id === this.botUserId) {
        mentionsBot = true;
        cuts.push({ ...entity, replacement: "" });
      } else if (entity.type === "bot_command") {
        const [command, target] = value.split("@");
        if (target === undefined || `@${target}`.toLowerCase() === handle) {
          mentionsBot ||= target !== undefined || entity.offset === 0;
          cuts.push({ ...entity, replacement: command! });
        }
      }
    }
    let text = raw;
    // Offsets count UTF-16 code units, as JavaScript strings do; cut from the end so they stay valid.
    for (const cut of cuts.sort((left, right) => right.offset - left.offset)) {
      text = text.slice(0, cut.offset) + cut.replacement + text.slice(cut.offset + cut.length);
    }
    return { text: text.trim(), mentionsBot };
  }

  private async download(fileId: string): Promise<Buffer> {
    const file = await this.request<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram did not provide the file");
    const response = await fetch(`${API}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed with ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async onButton(query: NonNullable<TelegramUpdate["callback_query"]>) {
    const data = query.data ?? "";
    const action = data.startsWith(BUTTON_PREFIX)
      ? await this.buttons.get(data.slice(BUTTON_PREFIX.length))
      : null;
    // Telegram shows a spinner on the button until the press is answered.
    await this.request("answerCallbackQuery", {
      callback_query_id: query.id,
      ...(action === null
        ? { text: "This button no longer works. Reply to the message instead.", show_alert: true }
        : {}),
    }).catch(() => {});
    if (action !== null) await this.handlers?.onAction(buttonInbound(action, String(query.from.id)));
  }

  // ── outbound ────────────────────────────────────────────────────────────

  async reply(message: InboundMessage, text: string): Promise<void> {
    await this.sendText(
      { channel: message.conversation.id, ...(message.ref.topic ? { topic: message.ref.topic } : {}) },
      text,
      [],
      Number(message.ref.ts),
    );
  }

  /** In Telegram a private chat's id is the person's user id. */
  async openDirect(userId: string): Promise<ConversationRef> {
    return { id: userId, label: "Direct message" };
  }

  async setRunStatus(message: MessageRef, status: RunStatus): Promise<void> {
    if (!message.channel || !message.ts) return;
    await this.request("setMessageReaction", {
      chat_id: message.channel,
      message_id: Number(message.ts),
      reaction: [{ type: "emoji", emoji: RUN_REACTIONS[status] }],
    });
    this.setTyping(message, status === "running");
  }

  /** "typing…" lasts five seconds, so it is renewed while the run lasts, for an hour at most. */
  private setTyping(message: MessageRef, working: boolean) {
    const key = `${message.channel}:${message.ts}`;
    clearInterval(this.typing.get(key));
    this.typing.delete(key);
    if (!working) return;
    const type = () =>
      void this.request("sendChatAction", {
        chat_id: message.channel,
        action: "typing",
        ...(message.topic ? { message_thread_id: Number(message.topic) } : {}),
      }).catch(() => {});
    type();
    const timer = setInterval(type, 4500);
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
    const target = {
      channel: existing?.channel ?? conversation.id,
      ...(conversation.meta?.topic ? { topic: conversation.meta.topic } : {}),
    };
    if (post.kind === "html") return existing ?? (await this.postHtml(target, post));
    const text = postText(post);
    const streaming = post.kind === "assistant" && post.streaming;
    const long = post.kind === "assistant" && !post.streaming && post.markdown.length > LONG_REPLY;
    const title = long ? reportTitle(post.markdown) : "";
    const body = long
      ? `${reportPreview(post.markdown)}\n\n📄 **Full reply attached:** ${title}`
      : text.markdown;
    let chunks = splitMarkdown(body, TELEGRAM_MESSAGE_LIMIT);
    // While streaming only the first chunk is shown; the rest follow once the message is complete.
    if (streaming) chunks = [`${chunks[0]}\n\n_✍️ writing…_`];
    const first = chunks[0]!.trim() || "🖼";
    const ref: Record<string, string> = { ...existing, ...target };
    if (existing?.ts) await this.editText(ref, existing.ts, first, text.buttons);
    else ref.ts = String(await this.sendText(target, first, text.buttons));
    // The main message is posted now; a failed follow-up must not make the caller post it again.
    try {
      if (!streaming) await this.postContinuations(ref, chunks.slice(1));
      if (long && ref.report !== "done") {
        await this.sendFile(ref, "sendDocument", "document", {
          name: `${safeFileName(title)}.md`,
          bytes: Buffer.from(post.markdown),
          mimeType: "text/markdown",
        });
        ref.report = "done";
      }
      if (post.kind === "assistant" && !streaming && post.images.length > 0 && ref.images !== "done") {
        await this.uploadImages(ref, post.images);
        ref.images = "done";
      }
    } catch (error) {
      this.log.warn(`[${this.name}] follow-up for ${post.kind} failed`, error);
    }
    return ref;
  }

  private async keyboard(rows: ReadonlyArray<ReadonlyArray<ChatButton>>) {
    if (rows.length === 0) return undefined;
    return {
      inline_keyboard: await Promise.all(
        rows.map((row) =>
          Promise.all(
            row.map(async (button) => ({
              text: truncate(button.label, 60),
              callback_data: `${BUTTON_PREFIX}${await this.buttons.put(button.action)}`,
            })),
          ),
        ),
      ),
    };
  }

  /** Sends markdown as Telegram HTML; if Telegram cannot parse the result, as plain text. */
  private async sendText(
    target: { channel: string; topic?: string },
    markdown: string,
    buttons: ReadonlyArray<ReadonlyArray<ChatButton>>,
    replyTo?: number,
  ): Promise<number> {
    const keyboard = await this.keyboard(buttons);
    const params = {
      chat_id: target.channel,
      link_preview_options: { is_disabled: true },
      ...(target.topic ? { message_thread_id: Number(target.topic) } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
      ...(replyTo === undefined
        ? {}
        : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
    };
    const sent = await this.withPlainFallback(markdown, (formatted) =>
      this.request<{ message_id: number }>("sendMessage", { ...params, ...formatted }),
    );
    return sent.message_id;
  }

  private async editText(
    ref: Record<string, string>,
    messageId: string,
    markdown: string,
    buttons: ReadonlyArray<ReadonlyArray<ChatButton>>,
  ) {
    const keyboard = await this.keyboard(buttons);
    try {
      // Leaving out reply_markup removes the buttons, e.g. once a question is answered.
      await this.withPlainFallback(markdown, (formatted) =>
        this.request("editMessageText", {
          chat_id: ref.channel,
          message_id: Number(messageId),
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: keyboard } : {}),
          ...formatted,
        }),
      );
    } catch (error) {
      if (error instanceof PlatformError && /message is not modified/i.test(error.message)) return;
      throw error;
    }
  }

  private async withPlainFallback<T>(
    markdown: string,
    send: (formatted: { text: string; parse_mode?: "HTML" }) => Promise<T>,
  ): Promise<T> {
    try {
      return await send({ text: toTelegramHtml(markdown), parse_mode: "HTML" });
    } catch (error) {
      if (!(error instanceof PlatformError) || !/can't parse entities|too long/i.test(error.message))
        throw error;
      this.log.warn(`[${this.name}] Telegram refused the formatting; sending plain text`);
      return send({ text: truncate(plainText(markdown), 4096) });
    }
  }

  /** Extra messages for text past the first; edited in place if the text changes again. */
  private async postContinuations(ref: Record<string, string>, rest: ReadonlyArray<string>) {
    const existing = ref.more ? ref.more.split(",") : [];
    const next: string[] = [];
    for (const [index, chunk] of rest.entries()) {
      const id = existing[index];
      if (id) {
        await this.editText(ref, id, chunk, []);
        next.push(id);
      } else {
        next.push(String(await this.sendText({ channel: ref.channel!, ...(ref.topic ? { topic: ref.topic } : {}) }, chunk, [])));
      }
    }
    for (const stale of existing.slice(rest.length)) {
      await this.request("deleteMessage", { chat_id: ref.channel, message_id: Number(stale) }).catch(() => {});
    }
    if (next.length > 0) ref.more = next.join(",");
    else delete ref.more;
  }

  private async uploadImages(ref: Record<string, string>, images: ReadonlyArray<ImageRef>) {
    for (const image of images) {
      try {
        const loaded = await image.load();
        const file = { name: image.name, ...loaded };
        // Photos are recompressed and size-limited; anything Telegram refuses goes as a file.
        await this.sendFile(ref, "sendPhoto", "photo", file).catch(() =>
          this.sendFile(ref, "sendDocument", "document", file),
        );
      } catch (error) {
        this.log.warn(`[${this.name}] uploading ${image.name} failed`, error);
      }
    }
  }

  private async sendFile(
    target: { channel?: string; topic?: string },
    method: "sendPhoto" | "sendDocument",
    field: "photo" | "document",
    file: { name: string; bytes: Buffer; mimeType: string },
    caption?: string,
  ) {
    const form = new FormData();
    form.append("chat_id", target.channel!);
    if (target.topic) form.append("message_thread_id", target.topic);
    if (caption) {
      form.append("caption", toTelegramHtml(caption));
      form.append("parse_mode", "HTML");
    }
    form.append(field, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name);
    return this.request<{ message_id: number }>(method, form);
  }

  private async postHtml(
    target: { channel: string; topic?: string },
    post: Extract<OutboundPost, { kind: "html" }>,
  ): Promise<MessageRef> {
    let loaded: { bytes: Buffer; mimeType: string };
    try {
      loaded = await post.html.load();
    } catch (error) {
      this.log.warn(`[${this.name}] preparing ${post.html.name} failed`, error);
      return { ...target, ts: String(await this.sendText(target, `🖼 ${post.title} (open it in T3)`, [])) };
    }
    const sent = await this.sendFile(
      target,
      "sendDocument",
      "document",
      { name: post.html.name, ...loaded },
      `🖼 **${post.title}**`,
    );
    return { ...target, ts: String(sent.message_id) };
  }
}

function messageFiles(
  message: TelegramMessage,
): Array<{ file_id: string; file_size?: number; name: string; mimeType: string }> {
  const files: Array<{ file_id: string; file_size?: number; name: string; mimeType: string }> = [];
  const largest = message.photo?.at(-1);
  if (largest !== undefined)
    files.push({ ...largest, name: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg" });
  for (const [kind, file] of [
    ["document", message.document],
    ["video", message.video],
    ["audio", message.audio],
    ["voice", message.voice],
  ] as const) {
    if (file === undefined) continue;
    files.push({
      ...file,
      name: file.file_name ?? `${kind}-${message.message_id}`,
      mimeType: file.mime_type ?? "application/octet-stream",
    });
  }
  return files;
}

function forwardSource(message: TelegramMessage): string | null {
  const origin = message.forward_origin;
  if (origin === undefined) return null;
  switch (origin.type) {
    case "user":
      return (
        [origin.sender_user?.first_name, origin.sender_user?.last_name].filter(Boolean).join(" ") ||
        "someone"
      );
    case "hidden_user":
      return origin.sender_user_name ?? "someone";
    case "chat":
      return origin.sender_chat?.title ?? "a group";
    case "channel":
      return origin.chat?.title ?? "a channel";
  }
}
