import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import * as DateTime from "effect/DateTime";

import {
  CommandId,
  MessageId,
  RuntimeRequestId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import type { Logger } from "../log.ts";
import { readJson, writeJsonAtomic, type BotConfig } from "../store.ts";
import type { T3Client } from "../t3/T3Client.ts";
import {
  LOCAL_FILE_MIME,
  ORCHESTRATOR_REMINDER,
  SILENT_REPLY,
  approvalPost,
  postFingerprint,
  postForTurnItem,
  questionPost,
  requestKey,
  runStatus,
  subagentPost,
  subagentTask,
  type KeyedPost,
  type RenderContext,
} from "./render.ts";
import {
  applyPost,
  applyRunStatus,
  MAX_ACTIVITY,
  newActivity,
  type ActivityEntry,
} from "./activity.ts";
import { truncate } from "./markdown.ts";
import { forgetFact, rememberedFacts, rememberFact } from "./memory.ts";
import {
  PlatformError,
  type AdapterStatus,
  type ChatAdapter,
  type ConversationRef,
  type EarlierMessage,
  type ImageRef,
  type InboundAction,
  type InboundFile,
  type InboundMessage,
  type MessageRef,
  type OutboundPost,
  type RunStatus,
} from "./types.ts";

interface PostRecord {
  readonly ref: MessageRef;
  readonly fingerprint: string;
  readonly conversation: ConversationRef;
  readonly kind: OutboundPost["kind"];
  readonly at: string;
  /** Set on approval and question posts; T3 ids contain colons, so they are not parsed from the key. */
  readonly request?: { readonly threadId: string; readonly requestId: string };
  /** A question still waiting for its answer. */
  readonly open?: boolean;
}

interface SentRecord {
  readonly ref: MessageRef;
  readonly status: RunStatus | null;
  readonly at: string;
  /** Where the run's replies go: the chat thread this message started or continued. */
  readonly conversation?: ConversationRef;
}

interface BotState {
  threadId: string | null;
  /** Thread activity older than this was there before the bot was connected and is not posted. */
  boundAt: string | null;
  lastSequence: number | null;
  /** Records posted before this were trimmed from `posts`; their items must not be posted again. */
  floorAt?: string;
  posts: Record<string, PostRecord>;
  sentMessages: Record<string, SentRecord>;
  lastConversation: ConversationRef | null;
  /** The thread someone last wrote in; replies that cannot be traced to a request go here. */
  lastThread?: ConversationRef | null;
  /** Conversations, as `${channel}:${ts}`, whose earlier messages were already sent to T3. */
  contextSent?: string[];
  /** Each chat thread's title (its opening request), keyed by `${channel}:${threadTs}`. */
  threadTitles?: Record<string, string>;
  /** The latest chat requests and what came of them, newest last. */
  activity?: ActivityEntry[];
  /** Replies and subagent results whose REMEMBER: lines were already saved to memory. */
  remembered?: string[];
  /** Wake-up replies shown in their request's status message instead of posted on their own. */
  statusReplies?: string[];
}

const MAX_RECORDS = 1500;
/** How often a reply that is still being written is pushed to chat; native streams take more. */
const STREAM_EDIT_INTERVAL_MS = 1500;
const NATIVE_STREAM_INTERVAL_MS = 700;
const MAX_DELIVERY_ATTEMPTS = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Earlier messages are quoted up to about this many characters, newest kept. */
const MAX_CONTEXT_CHARS = 6000;
const MAX_CONTEXT_FILES = 6;

export interface BotRuntimeOptions {
  readonly bot: BotConfig;
  readonly adapter: ChatAdapter;
  readonly t3: T3Client;
  readonly dataDir: string;
  readonly log: Logger;
  readonly platformLabel: string;
  /** Claims an unowned bot for the first person who messages it directly. */
  readonly claimOwner: (userId: string) => Promise<void>;
  /** Messages the bridge wrote outside a bot, such as a new thread's instructions. */
  readonly isBridgeMessage: (messageId: string) => boolean;
  /**
   * Agent layout: each request is its own chat thread, and everything a run produces (its
   * subagents, questions, and the summary after they finish) is posted in that thread.
   */
  readonly threaded: boolean;
  /** Creates a fresh orchestrator thread like the current one; the bot is not moved to it yet. */
  readonly createFreshThread: () => Promise<{ threadId: string; title: string }>;
  /** Points the bot at another T3 thread; this restarts the bot. */
  readonly switchThread: (threadId: string) => Promise<void>;
  /** The memory folder of the thread's project; null when T3 no longer has the project. */
  readonly memoryDir: () => Promise<string | null>;
}

interface ThreadModel {
  readonly nodes: Map<string, OrchestrationV2ExecutionNode>;
  readonly requests: Map<string, OrchestrationV2RuntimeRequest>;
  /** Approval and question items by request id, re-rendered when their request resolves. */
  readonly requestItems: Map<string, OrchestrationV2TurnItem>;
}

function emptyModel(): ThreadModel {
  return { nodes: new Map(), requests: new Map(), requestItems: new Map() };
}

/**
 * Connects one chat bot to one T3 thread, the orchestrator. Thread activity becomes chat
 * posts; chat messages become turns; buttons answer approvals and questions, including
 * those raised inside the orchestrator's delegated subagent threads.
 */
export class BotRuntime {
  private state!: BotState;
  private main = emptyModel();
  private readonly subagents = new Map<string, OrchestrationV2Subagent>();
  private readonly runs = new Map<string, OrchestrationV2Run>();
  private readonly children = new Map<
    string,
    { model: ThreadModel; unsubscribe: () => void; source: string; runId: string | null }
  >();
  private unsubscribeMain: (() => void) | null = null;
  private readonly desired = new Map<string, { post: OutboundPost; runId: string | null }>();
  /** Wake-up messages T3 sends when delegated work finishes, mapped to the run that delegated it. */
  private readonly wakeParents = new Map<string, string>();
  /** Wake-up replies held until their run ends, when it is known whether work is still going. */
  private readonly heldReplies = new Map<string, OrchestrationV2TurnItem>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  /** The in-memory model is rebuilt from a full snapshot once per process before resuming by sequence. */
  private mainSynced = false;
  private delivering = false;
  private deliveryTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  adapterStatus: AdapterStatus = { state: "connecting" };
  lastError: string | null = null;

  private readonly options: BotRuntimeOptions;

  constructor(options: BotRuntimeOptions) {
    this.options = options;
  }

  get bot() {
    return this.options.bot;
  }

  private get streamInterval() {
    return this.options.threaded ? NATIVE_STREAM_INTERVAL_MS : STREAM_EDIT_INTERVAL_MS;
  }

  private get stateFile() {
    return Path.join(this.options.dataDir, "state", `${this.bot.id}.json`);
  }

  async start(): Promise<void> {
    const stored = await readJson<BotState>(this.stateFile);
    this.state =
      stored !== null && stored.threadId === this.bot.threadId
        ? stored
        : {
            threadId: this.bot.threadId,
            boundAt: this.bot.threadId === null ? null : new Date().toISOString(),
            lastSequence: null,
            posts: {},
            sentMessages: {},
            lastConversation: stored?.lastConversation ?? null,
          };
    this.scheduleSave();
    if (this.bot.threadId !== null) this.subscribeMain(ThreadId.make(this.bot.threadId));
    void this.startAdapter();
  }

  /** The chat platform can be unreachable at login (no network yet); keep trying. */
  private async startAdapter() {
    for (let attempt = 0; !this.stopped; attempt += 1) {
      try {
        await this.options.adapter.start({
          onMessage: (message) => this.handleMessage(message),
          onAction: (action) => this.handleAction(action),
          onStatus: (status) => {
            this.adapterStatus = status;
          },
        });
        this.scheduleDelivery(0);
        return;
      } catch (error) {
        this.lastError = `${this.options.platformLabel}: ${errorText(error)}`;
        this.options.log.warn(
          `[${this.bot.name}] could not connect to ${this.options.platformLabel}`,
          error,
        );
        await this.options.adapter.stop().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2000 * 2 ** attempt)));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribeMain?.();
    for (const child of this.children.values()) child.unsubscribe();
    this.children.clear();
    if (this.deliveryTimer !== null) clearTimeout(this.deliveryTimer);
    await this.saveNow();
    await this.options.adapter.stop();
  }

  // ── T3 → chat ───────────────────────────────────────────────────────────

  private subscribeMain(threadId: ThreadId) {
    this.unsubscribeMain = this.options.t3.subscribeThread({
      threadId,
      afterSequence: () => (this.mainSynced ? (this.state.lastSequence ?? undefined) : undefined),
      onItem: (item) => this.handleMainItem(item),
      onError: (error) => {
        this.lastError = `Thread stream: ${String(error)}`.slice(0, 300);
      },
    });
  }

  private async handleMainItem(item: OrchestrationV2ThreadStreamItem) {
    if (item.kind === "snapshot") {
      this.lastError = null;
      this.applySnapshot(this.main, item.projection);
      for (const message of item.projection.messages) this.trackMessage(message);
      for (const run of item.projection.runs) this.applyRun(run);
      for (const subagent of item.projection.subagents) this.trackSubagent(subagent, true);
      for (const turnItem of item.projection.turnItems) this.renderMainItem(turnItem, true);
      this.state.lastSequence = item.snapshotSequence;
      this.mainSynced = true;
    } else if (item.kind === "event") {
      this.applyMainEvent(item.event);
      this.state.lastSequence = item.sequence;
    }
    this.scheduleSave();
  }

  private applySnapshot(model: ThreadModel, projection: OrchestrationV2ThreadProjection) {
    model.nodes.clear();
    model.requests.clear();
    for (const node of projection.nodes) model.nodes.set(node.id, node);
    for (const request of projection.runtimeRequests) model.requests.set(request.id, request);
  }

  private applyMainEvent(event: OrchestrationV2DomainEvent) {
    switch (event.type) {
      case "node.updated":
        this.main.nodes.set(event.payload.id, event.payload);
        return;
      case "runtime-request.updated": {
        this.main.requests.set(event.payload.id, event.payload);
        const item = this.main.requestItems.get(event.payload.id);
        if (item !== undefined) this.renderMainItem(item, false);
        return;
      }
      case "turn-item.updated":
        this.renderMainItem(event.payload, false);
        return;
      case "subagent.updated":
        this.trackSubagent(event.payload, false);
        return;
      case "message.updated":
        this.trackMessage(event.payload);
        return;
      case "run.created":
      case "run.updated":
        this.applyRun(event.payload);
        return;
      default:
        return;
    }
  }

  private isNew(updatedAt: unknown) {
    const boundAt = this.state.boundAt;
    if (boundAt === null) return false;
    const floor = Math.max(
      Date.parse(boundAt),
      this.state.floorAt ? Date.parse(this.state.floorAt) : 0,
    );
    return toMillis(updatedAt) >= floor;
  }

  private renderContext(threadId: string, model: ThreadModel): RenderContext {
    return {
      threadId,
      nodes: model.nodes,
      requests: model.requests,
      sentByBridge: (messageId) =>
        this.state.sentMessages[messageId] !== undefined || this.options.isBridgeMessage(messageId),
      localFile: (path) => ({
        name: Path.basename(path),
        load: () => readLocalFile(path),
      }),
      attachmentImage: (attachment) => ({
        name: attachment.name,
        load: () =>
          this.options.t3.downloadAsset({
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            disposition: "inline",
          }),
      }),
      htmlRender: (reference) => this.htmlRenderRefs(reference),
    };
  }

  private htmlRenderRefs(reference: { attachmentId: string; title: string }): ImageRef {
    return {
      name: `${safeFileName(reference.title)}.html`,
      load: async () => {
        const source = await this.options.t3.downloadAsset({
          _tag: "attachment",
          attachmentId: reference.attachmentId,
          disposition: "attachment",
        });
        return {
          bytes: Buffer.from(standaloneHtml(source.bytes.toString("utf8"))),
          mimeType: "text/html",
        };
      },
    };
  }

  private renderMainItem(item: OrchestrationV2TurnItem, fromSnapshot: boolean) {
    if (item.type === "approval_request" || item.type === "user_input_request") {
      this.main.requestItems.set(item.requestId, item);
    }
    if (
      !this.isNew(item.updatedAt) &&
      !(fromSnapshot && this.state.posts[keyOf(item)] !== undefined)
    ) {
      return;
    }
    // The agent's acknowledgement of the bridge's own setup instructions stays in T3.
    const run = item.runId === null ? undefined : this.runs.get(item.runId);
    if (run !== undefined && this.options.isBridgeMessage(run.userMessageId)) return;
    if (item.type === "assistant_message" && !item.streaming)
      void this.saveFacts(`a:${item.id}`, item.text, "orchestrator", item.runId);
    const keyed = postForTurnItem(item, this.renderContext(this.bot.threadId!, this.main));
    if (keyed === null) {
      this.heldReplies.delete(item.id);
      return;
    }
    if (item.type === "assistant_message" && run !== undefined && this.isWakeRun(run)) {
      this.routeWakeReply(item, keyed, run);
      return;
    }
    this.enqueue(keyed, item.runId);
  }

  private isWakeRun(run: OrchestrationV2Run) {
    return this.wakeParents.has(run.userMessageId);
  }

  /**
   * T3 wakes the orchestrator each time delegated work changes. While other work of the same
   * request is still going, its replies edit one status message in the thread instead of
   * adding (and notifying) a new one; the reply after all work is done is posted as usual.
   */
  private routeWakeReply(
    item: Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>,
    keyed: KeyedPost,
    run: OrchestrationV2Run,
  ) {
    if (item.streaming || runStatus(run.status) === "running" || runStatus(run.status) === null) {
      this.heldReplies.set(item.id, item);
      return;
    }
    this.heldReplies.delete(item.id);
    const posted = this.state.posts[keyed.key] !== undefined;
    const quiet =
      !posted &&
      (this.state.statusReplies?.includes(item.id) ||
        (keyed.post.kind === "assistant" &&
          keyed.post.images.length === 0 &&
          this.requestBusy(run.id)));
    if (!quiet) {
      this.enqueue(keyed, item.runId);
      return;
    }
    if (!this.state.statusReplies?.includes(item.id))
      this.state.statusReplies = [...(this.state.statusReplies ?? []), item.id].slice(-MAX_RECORDS);
    this.enqueue({ key: `w:${this.rootRun(run.id)}`, post: keyed.post }, item.runId);
  }

  /** The run a chat request started, following wake-up runs back to the run that delegated. */
  private rootRun(runId: string): string {
    let current = runId;
    for (let depth = 0; depth < 16; depth += 1) {
      const run = this.runs.get(current);
      const parent = run === undefined ? undefined : this.wakeParents.get(run.userMessageId);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  }

  /** Whether any subagent started for the same request as this run is still working. */
  private requestBusy(runId: string) {
    const root = this.rootRun(runId);
    return [...this.subagents.values()].some(
      (subagent) =>
        subagent.runId !== null &&
        ["pending", "running", "waiting"].includes(subagent.status) &&
        this.rootRun(subagent.runId) === root,
    );
  }

  private trackSubagent(subagent: OrchestrationV2Subagent, fromSnapshot: boolean) {
    this.subagents.set(subagent.id, subagent);
    if (subagent.status === "completed" && subagent.result && this.isNew(subagent.updatedAt))
      void this.saveFacts(
        `s:${subagent.id}`,
        subagent.result,
        `subagent "${truncate(subagentTask(subagent).title, 60)}"`,
        subagent.runId,
      );
    // In agent layout all subagents of one request, including those its wake-ups start,
    // share a single plan in its thread.
    const root = subagent.runId === null ? null : this.rootRun(subagent.runId);
    const grouped = this.options.threaded && root !== null;
    const key = grouped ? `g:${root}` : `s:${subagent.id}`;
    const hidden = isInsideNativeSubagent(subagent, this.main.nodes);
    if (
      !hidden &&
      (this.isNew(subagent.updatedAt) || (fromSnapshot && this.state.posts[key] !== undefined))
    ) {
      const post: OutboundPost = grouped
        ? {
            kind: "subagents",
            tasks: [...this.subagents.values()]
              .filter(
                (candidate) =>
                  candidate.runId !== null &&
                  this.rootRun(candidate.runId) === root &&
                  !isInsideNativeSubagent(candidate, this.main.nodes),
              )
              .map(subagentTask),
          }
        : subagentPost(subagent);
      this.enqueue({ key, post }, subagent.runId);
    }
    this.syncChildSubscription(subagent);
  }

  /** Delegated subagents run in their own threads; watch those only for approvals and questions. */
  private syncChildSubscription(subagent: OrchestrationV2Subagent) {
    const childThreadId = subagent.childThreadId;
    if (childThreadId === null) return;
    const active =
      subagent.status === "pending" ||
      subagent.status === "running" ||
      subagent.status === "waiting";
    const existing = this.children.get(childThreadId);
    if (active && existing === undefined) {
      const model = emptyModel();
      const source = subagent.title ?? "Subagent";
      const unsubscribe = this.options.t3.subscribeThread({
        threadId: childThreadId,
        afterSequence: () => undefined,
        onItem: async (item) =>
          this.handleChildItem(childThreadId, model, source, subagent.runId, item),
        onError: () => {},
      });
      this.children.set(childThreadId, { model, unsubscribe, source, runId: subagent.runId });
    } else if (!active && existing !== undefined) {
      existing.unsubscribe();
      this.children.delete(childThreadId);
      // Requests still open when the subagent ended can no longer be answered.
      for (const item of existing.model.requestItems.values()) {
        const key = requestKey(childThreadId, requestIdOf(item));
        const request = existing.model.requests.get(requestIdOf(item));
        if (this.state.posts[key] !== undefined)
          this.enqueue(
            childRequestPost(childThreadId, item, request, existing.source, true),
            existing.runId,
          );
      }
    }
  }

  private async handleChildItem(
    threadId: string,
    model: ThreadModel,
    source: string,
    runId: string | null,
    item: OrchestrationV2ThreadStreamItem,
  ) {
    const render = (turnItem: OrchestrationV2TurnItem) => {
      if (turnItem.type !== "approval_request" && turnItem.type !== "user_input_request") return;
      model.requestItems.set(turnItem.requestId, turnItem);
      const request = model.requests.get(turnItem.requestId);
      const key = requestKey(threadId, turnItem.requestId);
      if (request?.status !== "pending" && this.state.posts[key] === undefined) return;
      this.enqueue(childRequestPost(threadId, turnItem, request, source, false), runId);
    };
    if (item.kind === "snapshot") {
      this.applySnapshot(model, item.projection);
      for (const turnItem of item.projection.turnItems) render(turnItem);
    } else if (item.kind === "event") {
      const event = item.event;
      if (event.type === "runtime-request.updated") {
        model.requests.set(event.payload.id, event.payload);
        const turnItem = model.requestItems.get(event.payload.id);
        if (turnItem !== undefined) render(turnItem);
      } else if (event.type === "turn-item.updated") {
        render(event.payload);
      }
    }
  }

  private applyRun(run: OrchestrationV2Run) {
    this.runs.set(run.id, run);
    const status = runStatus(run.status);
    if (status !== null && status !== "running")
      for (const held of [...this.heldReplies.values()])
        if (held.runId === run.id) this.renderMainItem(held, false);
    if (status !== null) this.updateActivity(run.id, (entry) => applyRunStatus(entry, status));
    const sent = this.state.sentMessages[run.userMessageId];
    if (sent === undefined) return;
    if (status === null || status === sent.status) return;
    this.state.sentMessages[run.userMessageId] = { ...sent, status };
    this.options.adapter
      .setRunStatus(sent.ref, status, sent.status, sent.conversation?.threadTs)
      .catch((error: unknown) =>
        this.options.log.warn(`[${this.bot.name}] status reaction`, error),
      );
  }

  private trackMessage(message: OrchestrationV2ConversationMessage) {
    const parentRunId = message.delegatedCompletion?.parentRunId;
    if (parentRunId !== undefined) this.wakeParents.set(message.id, parentRunId);
  }

  private enqueue(keyed: KeyedPost, runId: string | null) {
    this.desired.set(keyed.key, { post: keyed.post, runId });
    this.updateActivity(runId, (entry) => applyPost(entry, keyed.post));
    this.scheduleDelivery(0);
  }

  // ── activity, for the control panel ─────────────────────────────────────

  get activity(): ReadonlyArray<ActivityEntry> {
    return this.state?.activity ?? [];
  }

  private recordActivity(entry: ActivityEntry) {
    const activity = [...this.activity, entry];
    this.state.activity = activity.slice(-MAX_ACTIVITY);
    this.scheduleSave();
  }

  /** Updates the request a run belongs to, following summaries back to the run that delegated. */
  private updateActivity(runId: string | null, change: (entry: ActivityEntry) => ActivityEntry) {
    let current = runId;
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      const run = this.runs.get(current);
      if (run === undefined) return;
      const index = this.activity.findIndex((entry) => entry.id === run.userMessageId);
      if (index !== -1) {
        const before = this.activity[index]!;
        const after = change(before);
        if (after !== before) {
          this.state.activity = this.activity.with(index, after);
          this.scheduleSave();
        }
        return;
      }
      current = this.wakeParents.get(run.userMessageId) ?? null;
    }
  }

  /**
   * The chat thread a run's output belongs in: the thread of the chat message that started
   * it, the thread under a message typed in T3, or, for the summary T3 asks for after
   * delegated work finishes, the thread of the run that delegated it.
   */
  private runThread(runId: string | null): ConversationRef | null {
    let current = runId;
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      const run = this.runs.get(current);
      if (run === undefined) return null;
      const sent = this.state.sentMessages[run.userMessageId];
      if (sent !== undefined) {
        // A request sent before the bot switched to threads still gets its thread: its message.
        const conversation = sent.conversation ?? this.state.lastConversation;
        if (conversation !== null && conversation !== undefined) {
          return { ...conversation, threadTs: conversation.threadTs ?? sent.ref.ts! };
        }
      }
      const echo = this.state.posts[`u:${run.userMessageId}`];
      if (echo?.ref.ts !== undefined) return { ...echo.conversation, threadTs: echo.ref.ts };
      current = this.wakeParents.get(run.userMessageId) ?? null;
    }
    return null;
  }

  private async targetFor(
    post: OutboundPost,
    runId: string | null,
  ): Promise<ConversationRef | null> {
    const home = await this.homeConversation();
    if (!this.options.threaded) return home;
    // Text typed in T3 opens a new thread of its own; its run's replies follow it there.
    if (post.kind === "echo") return home === null ? null : { id: home.id, label: home.label };
    return this.runThread(runId) ?? this.state.lastThread ?? home;
  }

  private scheduleDelivery(delayMs: number) {
    if (this.stopped || this.deliveryTimer !== null) return;
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = null;
      void this.deliver();
    }, delayMs);
  }

  /** Posts in the order things happened, one at a time, and coalesces streaming edits. */
  private async deliver() {
    if (this.delivering) return;
    this.delivering = true;
    let retryIn: number | null = null;
    try {
      for (const [key, { post, runId }] of [...this.desired]) {
        if (this.stopped) return;
        const record = this.state.posts[key];
        const fingerprint = postFingerprint(post);
        if (record?.fingerprint === fingerprint) {
          this.desired.delete(key);
          continue;
        }
        const now = Date.now();
        const lastEdit = this.lastEditAt.get(key) ?? 0;
        if (
          record !== undefined &&
          post.kind === "assistant" &&
          post.streaming &&
          now - lastEdit < this.streamInterval
        ) {
          retryIn = Math.min(retryIn ?? Infinity, this.streamInterval - (now - lastEdit));
          continue;
        }
        this.desired.delete(key);
        try {
          const conversation = record?.conversation ?? (await this.targetFor(post, runId));
          if (conversation === null) continue;
          const ref = await this.options.adapter.upsert(conversation, post, record?.ref ?? null);
          this.lastEditAt.set(key, Date.now());
          this.attempts.delete(key);
          this.state.posts[key] = {
            ref,
            fingerprint,
            conversation,
            kind: post.kind,
            at: new Date().toISOString(),
            ...(post.kind === "approval" || post.kind === "question"
              ? { request: { threadId: post.threadId, requestId: post.requestId } }
              : {}),
            ...(post.kind === "question" && !post.resolved ? { open: true } : {}),
          };
          this.scheduleSave();
        } catch (error) {
          this.options.log.warn(`[${this.bot.name}] posting ${post.kind} failed`, error);
          this.lastError = `Posting to ${this.options.platformLabel} failed: ${errorText(error)}`;
          // Rate limits and blips are retried for about a minute; then the post is dropped.
          const attempts = (this.attempts.get(key) ?? 0) + 1;
          this.attempts.set(key, attempts);
          if (
            !this.desired.has(key) &&
            !isPermanentFailure(error) &&
            attempts < MAX_DELIVERY_ATTEMPTS
          ) {
            this.desired.set(key, { post, runId });
            retryIn = Math.min(retryIn ?? Infinity, 5000);
          } else {
            this.attempts.delete(key);
          }
        }
      }
    } finally {
      this.delivering = false;
      if (retryIn !== null) this.scheduleDelivery(retryIn);
      else if (this.desired.size > 0) this.scheduleDelivery(50);
    }
  }

  private async homeConversation(): Promise<ConversationRef | null> {
    if (this.state.lastConversation !== null) return this.state.lastConversation;
    const owner = this.bot.allowedUserIds[0];
    if (owner === undefined || this.options.adapter.openDirect === undefined) return null;
    this.state.lastConversation = await this.options.adapter.openDirect(owner);
    return this.state.lastConversation;
  }

  // ── chat → T3 ───────────────────────────────────────────────────────────

  private isAllowed(userId: string) {
    return this.bot.allowedUserIds.includes(userId);
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const { adapter, log } = this.options;
    let claimed = false;
    if (!this.isAllowed(message.userId)) {
      if (this.bot.allowedUserIds.length === 0 && message.isDirect) {
        await this.options.claimOwner(message.userId);
        claimed = true;
        await adapter.reply(
          message,
          `You now own this bot, ${message.userName}. Only you can send it work; add others in T3 Bridge.`,
        );
      } else {
        if (!message.isDirect && !message.mentionsBot) return;
        await adapter.reply(
          message,
          `Sorry, you are not allowed to use this bot. Ask its owner to add your ${this.options.platformLabel} user id \`${message.userId}\` in T3 Bridge.`,
        );
        return;
      }
    }
    // Telegram opens every chat with /start; it is a greeting, not work.
    if (/^\/start(\s|$)/i.test(message.text.trim())) {
      if (!claimed)
        await adapter.reply(message, `Hi ${message.userName}. Send me a request and I'll pass it to the agent.`);
      return;
    }
    // In a shared channel only messages addressed to the bot are work: a mention, or a reply
    // under one of the bot's own posts. Direct messages always are.
    if (!message.isDirect && !message.mentionsBot && !this.isReplyToBot(message.replyTo)) return;
    const threadId = this.bot.threadId;
    if (threadId === null) {
      await adapter.reply(
        message,
        "This bot is not connected to a T3 thread yet. Pick one in T3 Bridge.",
      );
      return;
    }
    this.state.lastConversation = {
      id: message.conversation.id,
      label: message.conversation.label,
    };
    // In agent layout every request is a thread: a new message starts one, a reply continues it.
    const conversation: ConversationRef = this.options.threaded
      ? { ...message.conversation, threadTs: message.replyTo?.ts ?? message.ref.ts! }
      : message.conversation;
    if (this.options.threaded) this.state.lastThread = conversation;

    const text = message.text.trim();
    if (/^(!stop|stop!|\/stop)$/i.test(text)) {
      await this.stopThread();
      await adapter.reply(message, "⏹ Stopping the agent.");
      return;
    }
    if (/^(!new|new!|\/new)$/i.test(text)) {
      await this.startFreshThread(message);
      return;
    }
    const memoryCommand = /^[!/](remember|forget)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (memoryCommand !== null) {
      await this.memoryCommand(message, memoryCommand[1]!.toLowerCase(), memoryCommand[2]?.trim() ?? "");
      return;
    }

    const answered = await this.answerFromReply(message, text);
    if (answered) return;

    const earlier = await this.earlierContext(message);
    let recorded: string | null = null;
    try {
      const attachments = await this.uploadFiles({
        ...message,
        files: [...earlier.files, ...message.files],
      });
      const messageId = MessageId.make(Crypto.randomUUID());
      this.state.sentMessages[messageId] = {
        ref: message.ref,
        status: null,
        at: new Date().toISOString(),
        conversation,
      };
      this.scheduleSave();
      const title = this.threadTitle(message, conversation, text, earlier.opening);
      const prefix = `[${[
        this.options.platformLabel,
        message.userName,
        ...(title === null
          ? []
          : [`${message.replyTo === null ? "new thread" : "thread"} "${title}"`]),
        ...(this.bot.reminder ? ["delegate via subagents, brief them from project memory"] : []),
        `on wake-ups that need nothing from the user, reply only ${SILENT_REPLY}`,
        ...(this.options.adapter.mentionHint ? [this.options.adapter.mentionHint] : []),
      ].join(" · ")}]\n`;
      // Recorded before dispatching: the run's first events can arrive before dispatch returns.
      recorded = messageId;
      this.recordActivity(
        newActivity({ id: messageId, user: message.userName, text, files: message.files.length }),
      );
      await this.options.t3.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(Crypto.randomUUID()),
        createdBy: "user",
        creationSource: "mobile",
        threadId: ThreadId.make(threadId),
        messageId,
        text: `${prefix}${earlier.text}${text.length > 0 ? text : "(see attachments)"}`,
        attachments,
        dispatchMode: { type: "queue_after_active" },
      });
      await adapter
        .setRunStatus(message.ref, "running", null, conversation.threadTs)
        .catch(() => {});
      this.state.sentMessages[messageId] = {
        ref: message.ref,
        status: "running",
        at: new Date().toISOString(),
        conversation,
      };
    } catch (error) {
      log.error(`[${this.bot.name}] sending a message to T3 failed`, error);
      const failed = newActivity({
        id: recorded ?? Crypto.randomUUID(),
        user: message.userName,
        text,
        files: message.files.length,
        error: `Could not reach T3: ${errorText(error)}`,
      });
      if (recorded === null) this.recordActivity(failed);
      else this.state.activity = this.activity.map((entry) => (entry.id === recorded ? failed : entry));
      await adapter.reply(message, `⚠️ Could not reach T3: ${errorText(error)}`);
    }
  }

  /**
   * Every chat thread feeds the same T3 conversation, so each message says which thread it
   * came from; a reply like "yes, merge it" then reaches the orchestrator with its subject.
   * A new thread is named after its opening request, in Slack's thread list too.
   */
  private threadTitle(
    message: InboundMessage,
    conversation: ConversationRef,
    text: string,
    /** The first earlier message, when the bot joined a thread it did not start. */
    opening: string | null,
  ): string | null {
    if (!this.options.threaded || conversation.threadTs === undefined) return null;
    const key = `${conversation.id}:${conversation.threadTs}`;
    this.state.threadTitles ??= {};
    const known = this.state.threadTitles[key];
    if (known !== undefined) return known;
    if (message.replyTo !== null && opening === null) return null;
    const title = requestTitle(opening ?? text);
    this.state.threadTitles[key] = title;
    const titles = Object.entries(this.state.threadTitles);
    if (titles.length > MAX_RECORDS)
      this.state.threadTitles = Object.fromEntries(titles.slice(-MAX_RECORDS));
    void this.options.adapter.setThreadTitle?.(conversation, title).catch(() => {});
    return title;
  }

  /**
   * When someone brings the bot into a conversation it was not part of (a mention under an
   * alert, a reply to someone else's message), the agent gets what came before, quoted, with
   * its files. Each conversation's history is sent once; later messages build on it in T3.
   */
  private async earlierContext(
    message: InboundMessage,
  ): Promise<{ text: string; files: ReadonlyArray<InboundFile>; opening: string | null }> {
    const none = { text: "", files: [], opening: null };
    const replyTo = message.replyTo;
    if (message.earlier === undefined || this.isReplyToBot(replyTo)) return none;
    // Without a reply (a mention in a Discord thread) the adapter only returns what the bot
    // missed since it last spoke there, so there is nothing to send twice.
    const key = `${message.conversation.id}:${replyTo?.ts ?? message.ref.ts}`;
    if (this.state.contextSent?.includes(key)) return none;
    let messages: ReadonlyArray<EarlierMessage>;
    try {
      messages = await message.earlier();
    } catch (error) {
      this.options.log.warn(`[${this.bot.name}] reading the earlier messages failed`, error);
      return none;
    }
    if (messages.length === 0) return none;
    this.state.contextSent = [...(this.state.contextSent ?? []), key].slice(-MAX_RECORDS);
    return {
      text: `${earlierText(messages)}

`,
      files: messages.flatMap((earlier) => earlier.files).slice(-MAX_CONTEXT_FILES),
      opening: messages[0]!.text,
    };
  }

  // ── project memory ──────────────────────────────────────────────────────

  /** `!remember <fact>` saves a fact as said; `!forget <words>` removes the lines that contain them. */
  private async memoryCommand(message: InboundMessage, command: string, argument: string) {
    const { adapter } = this.options;
    if (argument.length === 0) {
      await adapter.reply(message, `Usage: \`!${command} <${command === "remember" ? "fact" : "words in the fact"}>\``);
      return;
    }
    try {
      const dir = await this.options.memoryDir();
      if (dir === null) throw new Error("this bot's thread has no project in T3");
      if (command === "remember") {
        const saved = await rememberFact(dir, argument, message.userName);
        await adapter.reply(message, saved ? `🧠 Saved to project memory: ${argument}` : "🧠 Project memory already has that.");
      } else {
        const removed = await forgetFact(dir, argument);
        await adapter.reply(
          message,
          removed.length === 0
            ? `🧠 No memory line contains "${argument}".`
            : `🧠 Removed from project memory:\n${removed.map((line) => `> ${line.replace(/^\s*-\s*/, "")}`).join("\n")}`,
        );
      }
    } catch (error) {
      await adapter.reply(message, `⚠️ Could not update project memory: ${errorText(error)}`);
    }
  }

  /**
   * Saves the facts an agent marked with REMEMBER: in a finished reply or subagent result,
   * and says so in the request's chat thread. Each reply or result is read once.
   */
  private async saveFacts(id: string, text: string, source: string, runId: string | null) {
    const facts = rememberedFacts(text);
    if (facts.length === 0 || this.state.remembered?.includes(id)) return;
    this.state.remembered = [...(this.state.remembered ?? []), id].slice(-MAX_RECORDS);
    this.scheduleSave();
    try {
      const dir = await this.options.memoryDir();
      if (dir === null) return;
      const saved: string[] = [];
      for (const fact of facts) if (await rememberFact(dir, fact, source)) saved.push(fact);
      if (saved.length === 0) return;
      this.enqueue(
        {
          key: `m:${id}`,
          post: {
            kind: "notice",
            markdown: `🧠 Saved to project memory:\n${saved.map((fact) => `• ${fact}`).join("\n")}\nSend \`!forget <words>\` to remove one.`,
          },
        },
        runId,
      );
    } catch (error) {
      this.options.log.warn(`[${this.bot.name}] saving to project memory failed`, error);
    }
  }

  /** `!new`: a fresh orchestrator thread when the current one has grown long. */
  private async startFreshThread(message: InboundMessage) {
    const { adapter } = this.options;
    try {
      await adapter.reply(message, "🆕 Starting a fresh orchestrator thread…");
      const fresh = await this.options.createFreshThread();
      await adapter.reply(
        message,
        `🆕 New orchestrator thread "${fresh.title}" is ready, with the same instructions. The old thread stays in T3.`,
      );
      void this.options.switchThread(fresh.threadId);
    } catch (error) {
      await adapter.reply(message, `⚠️ Could not start a new thread: ${errorText(error)}`);
    }
  }

  private async uploadFiles(message: InboundMessage): Promise<ChatAttachment[]> {
    const attachments: ChatAttachment[] = [];
    for (const file of message.files) {
      const limit = file.mimeType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.sizeBytes > limit) {
        await this.options.adapter.reply(
          message,
          `⚠️ ${file.name} is too large to forward (limit ${limit / 1024 / 1024} MB).`,
        );
        continue;
      }
      const bytes = await file.download();
      const uploaded = await this.options.t3.uploadAttachment({
        name: file.name,
        mimeType: file.mimeType,
        bytes,
      });
      attachments.push(
        uploaded.type === "image"
          ? ({
              type: "image",
              id: uploaded.attachmentId,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: bytes.byteLength,
            } as ChatAttachment)
          : ({
              type: "file",
              id: uploaded.attachmentId,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: bytes.byteLength,
            } as ChatAttachment),
      );
    }
    return attachments;
  }

  private isReplyToBot(replyTo: MessageRef | null) {
    if (replyTo === null) return false;
    return (
      Object.values(this.state.posts).some(
        (record) => sameRef(record.ref, replyTo) || record.conversation.threadTs === replyTo.ts,
      ) ||
      Object.values(this.state.sentMessages).some(
        (sent) => sent.conversation?.threadTs === replyTo.ts,
      )
    );
  }

  /** A reply under a question the bot asked answers that question with free text. */
  private async answerFromReply(message: InboundMessage, text: string): Promise<boolean> {
    if (message.replyTo === null || text.length === 0) return false;
    const replyTo = message.replyTo;
    // A reply under the question itself, or, in agent layout, in the thread it was asked in.
    const candidates = Object.values(this.state.posts)
      .filter(
        (record) =>
          record.kind === "question" &&
          (sameRef(record.ref, replyTo) ||
            (record.open === true && record.conversation.threadTs === replyTo.ts)),
      )
      .sort((left, right) => right.at.localeCompare(left.at));
    for (const record of candidates) {
      if (record.request === undefined) return false;
      const { threadId, requestId } = record.request;
      const item = (this.children.get(threadId)?.model ?? this.main).requestItems.get(requestId);
      if (item?.type !== "user_input_request") return false;
      const answers = Object.fromEntries(item.questions.map((question) => [question.id, text]));
      await this.handleAction({
        type: "answer",
        userId: message.userId,
        threadId,
        requestId,
        answers,
      });
      return true;
    }
    return false;
  }

  async handleAction(action: InboundAction): Promise<void> {
    if (!this.isAllowed(action.userId)) return;
    const { t3, log } = this.options;
    try {
      if (action.type === "stop") {
        await this.stopThread();
      } else if (action.type === "approval") {
        await t3.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(Crypto.randomUUID()),
          threadId: ThreadId.make(action.threadId),
          requestId: RuntimeRequestId.make(action.requestId),
          decision: action.decision,
        });
      } else {
        await t3.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(Crypto.randomUUID()),
          threadId: ThreadId.make(action.threadId),
          requestId: RuntimeRequestId.make(action.requestId),
          answers: action.answers,
        });
      }
    } catch (error) {
      log.error(`[${this.bot.name}] ${action.type} failed`, error);
      this.lastError = `${action.type} failed: ${errorText(error)}`;
    }
  }

  /** Stops the agent's current turn, as a stop reaction in chat would. */
  async stopThread() {
    if (this.bot.threadId === null) return;
    await this.options.t3.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(Crypto.randomUUID()),
      threadId: ThreadId.make(this.bot.threadId),
    });
  }

  // ── persistence ─────────────────────────────────────────────────────────

  private scheduleSave() {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 1000);
  }

  private async saveNow() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const trimmed = newest(this.state.posts);
    if (trimmed.floorAt !== null) this.state.floorAt = trimmed.floorAt;
    this.state.posts = trimmed.records;
    this.state.sentMessages = newest(this.state.sentMessages).records;
    await writeJsonAtomic(this.stateFile, this.state).catch((error: unknown) =>
      this.options.log.error(`[${this.bot.name}] saving state failed`, error),
    );
  }
}

/** Decoded RPC payloads carry Effect `DateTime`s; HTTP JSON carries ISO strings. */
export function toMillis(value: unknown): number {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  return typeof value === "string" || typeof value === "number"
    ? new Date(value).getTime()
    : Number.NaN;
}

/** The bridge runs on the same Mac as T3, so a file the agent saved there is read directly. */
async function readLocalFile(path: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const mimeType = LOCAL_FILE_MIME[Path.extname(path).toLowerCase()];
  if (mimeType === undefined) throw new Error(`${path} is not a media file`);
  const limit = mimeType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  const stat = await FS.stat(path);
  if (!stat.isFile() || stat.size > limit) throw new Error(`${path} is missing or too large`);
  return { bytes: await FS.readFile(path), mimeType };
}

/**
 * Earlier messages quoted for the agent, newest kept when they run long. The opening message
 * (an alert, the question) is always kept, since it is what the thread is about.
 */
export function earlierText(messages: ReadonlyArray<EarlierMessage>): string {
  const quote = (earlier: EarlierMessage) => {
    const files = earlier.files.length;
    const body = earlier.text.trim() || (files > 0 ? "(files only)" : "(no text)");
    const note = files > 0 ? ` [${files} file${files === 1 ? "" : "s"} attached]` : "";
    return [`${earlier.author}${note}:`, ...body.split("\n").map((line) => `> ${line}`)].join("\n");
  };
  const [first, ...rest] = messages.map(quote);
  const kept: string[] = [];
  let size = first!.length;
  for (const quoted of rest.reverse()) {
    if (size + quoted.length > MAX_CONTEXT_CHARS) break;
    kept.unshift(quoted);
    size += quoted.length;
  }
  const skipped = rest.length - kept.length;
  return [
    "Earlier in this conversation, before you were brought in:",
    truncate(first!, MAX_CONTEXT_CHARS),
    ...(skipped > 0 ? [`(${skipped} more message${skipped === 1 ? "" : "s"} not shown)`] : []),
    ...kept,
    "The request:",
  ].join("\n\n");
}

/** The opening request, trimmed to a short thread title. */
export function requestTitle(text: string): string {
  const line = text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length === 0) return "Files";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

function newest<T extends { at: string }>(
  records: Record<string, T>,
): { records: Record<string, T>; floorAt: string | null } {
  const entries = Object.entries(records);
  if (entries.length <= MAX_RECORDS) return { records, floorAt: null };
  entries.sort((left, right) => left[1].at.localeCompare(right[1].at));
  const dropped = entries.slice(0, entries.length - MAX_RECORDS);
  return {
    records: Object.fromEntries(entries.slice(-MAX_RECORDS)),
    floorAt: dropped.at(-1)![1].at,
  };
}

function keyOf(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "assistant_message":
      return `a:${item.id}`;
    case "user_message":
      return `u:${item.messageId}`;
    case "proposed_plan":
      return `p:${item.id}`;
    case "todo_list":
      return `t:${item.id}`;
    case "error":
      return `e:${item.id}`;
    case "dynamic_tool":
      return `h:${item.id}`;
    case "approval_request":
    case "user_input_request":
      return requestKey(item.threadId, item.requestId);
    default:
      return `x:${item.id}`;
  }
}

function requestIdOf(item: OrchestrationV2TurnItem): string {
  return item.type === "approval_request" || item.type === "user_input_request"
    ? item.requestId
    : "";
}

function childRequestPost(
  threadId: string,
  item: OrchestrationV2TurnItem,
  request: OrchestrationV2RuntimeRequest | undefined,
  source: string,
  ended: boolean,
): KeyedPost {
  const key = requestKey(threadId, requestIdOf(item));
  const settled: OrchestrationV2RuntimeRequest | undefined =
    ended && (request === undefined || request.status === "pending")
      ? ({ ...(request ?? {}), status: "expired" } as OrchestrationV2RuntimeRequest)
      : request;
  if (item.type === "approval_request")
    return { key, post: approvalPost(threadId, item, settled, source) };
  if (item.type === "user_input_request")
    return { key, post: questionPost(threadId, item, settled, source) };
  throw new Error(`Not a request item: ${item.type}`);
}

function isInsideNativeSubagent(
  subagent: OrchestrationV2Subagent,
  nodes: ReadonlyMap<string, OrchestrationV2ExecutionNode>,
): boolean {
  let current = nodes.get(subagent.parentNodeId);
  for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
    if (current.kind === "subagent") return true;
    current = current.parentNodeId === null ? undefined : nodes.get(current.parentNodeId);
  }
  return false;
}

function sameRef(left: MessageRef, right: MessageRef) {
  const keys = Object.keys(right);
  return keys.length > 0 && keys.every((key) => left[key] === right[key]);
}

/**
 * T3 draws an html_render inside its reply column, with its theme variables and base styles
 * injected and the column's margins around it. Opened on its own the page has neither, so
 * give it the same theme (light or dark from the reader's system) and some breathing room.
 * The padding rule has no specificity, so a page that sets its own still wins.
 */
export function standaloneHtml(html: string): string {
  const themed = injectHtmlRenderBootstrap(html);
  const padding = '<style id="t3-bridge-standalone">:where(html){padding:24px 20px}</style>';
  const themeEnd = themed.indexOf("</script>", themed.indexOf('<style id="t3-theme">'));
  if (themeEnd === -1) return padding + themed;
  const at = themeEnd + "</script>".length;
  return themed.slice(0, at) + padding + themed.slice(at);
}

function safeFileName(title: string) {
  return (
    title
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "render"
  );
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

const PERMANENT_FAILURES = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_blocks",
  "message_not_found",
  "cant_update_message",
  "msg_too_long",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "missing_scope",
  "user_not_found",
]);

function isPermanentFailure(error: unknown) {
  if (error instanceof PlatformError) return error.permanent;
  const code = (error as { data?: { error?: string } })?.data?.error;
  return code !== undefined && PERMANENT_FAILURES.has(code);
}
