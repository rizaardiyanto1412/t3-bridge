import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
  type AssetResource,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import type { Logger } from "../log.ts";

const INLINE_IMAGE_MIME_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;

const makeClient = RpcClient.make(WsRpcGroup);
type WsClient = Effect.Success<typeof makeClient>;

export type T3ConnectionStatus =
  | { readonly state: "connecting" }
  | { readonly state: "connected"; readonly label: string }
  | { readonly state: "disconnected"; readonly error: string };

export class T3AuthError extends Error {}

/** Something that can hand out a bearer token for the environment, minting a new one when asked. */
export interface T3Credentials {
  readonly httpBaseUrl: string;
  /** Re-reads where the server listens; T3 can come back on another port after a restart. */
  readonly refreshOrigin?: () => Promise<void>;
  readonly getToken: (options: { readonly refresh: boolean }) => Promise<string>;
}

interface Subscription {
  readonly open: (client: WsClient) => Stream.Stream<unknown, unknown>;
  readonly onItem: (item: unknown) => Promise<void>;
  readonly onError: (error: unknown) => void;
  fiber: Fiber.Fiber<unknown, unknown> | null;
}

/**
 * One WebSocket session to a T3 environment, reopened with backoff whenever it drops.
 * Subscriptions survive reconnects: each is reopened on the next session, and its
 * owner decides what cursor to resume from.
 */
export class T3Client {
  private session: { client: WsClient; scope: Scope.Closeable } | null = null;
  private readonly subscriptions = new Set<Subscription>();
  private loop: Fiber.Fiber<void, never> | null = null;
  private readonly statusListeners = new Set<(status: T3ConnectionStatus) => void>();
  private readyWaiters: Array<() => void> = [];
  status: T3ConnectionStatus = { state: "connecting" };
  label = "T3";

  private readonly credentials: T3Credentials;
  private readonly log: Logger;

  constructor(credentials: T3Credentials, log: Logger) {
    this.credentials = credentials;
    this.log = log;
  }

  onStatus(listener: (status: T3ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    if (this.loop !== null) return;
    this.loop = Effect.runFork(this.runLoop());
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    this.loop = null;
    if (loop !== null) await Effect.runPromise(Fiber.interrupt(loop));
    await this.closeSession();
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  async fetchDescriptor(): Promise<{ environmentId: string; label: string; protocol: number }> {
    const response = await fetch(
      new URL("/.well-known/t3/environment", this.credentials.httpBaseUrl),
    );
    if (!response.ok) throw new Error(`T3 environment answered ${response.status}`);
    const body = (await response.json()) as {
      environmentId: string;
      label: string;
      orchestrationProtocolVersion?: number;
    };
    return {
      environmentId: body.environmentId,
      label: body.label,
      protocol: body.orchestrationProtocolVersion ?? 0,
    };
  }

  async getShell(): Promise<OrchestrationV2ShellSnapshot> {
    return (await this.authorizedJson("/api/orchestration/shell", {
      headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
    })) as OrchestrationV2ShellSnapshot;
  }

  /** Downloads a signed asset URL. The token in the path is the credential. */
  async downloadAsset(resource: AssetResource): Promise<{ bytes: Buffer; mimeType: string }> {
    const { relativeUrl } = await this.request((client) =>
      client[WS_METHODS.assetsCreateUrl]({ resource }),
    );
    const response = await fetch(new URL(relativeUrl, this.credentials.httpBaseUrl));
    if (!response.ok) throw new Error(`Asset download failed with ${response.status}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async uploadAttachment(input: {
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Buffer;
  }): Promise<{ attachmentId: string; type: "image" | "file" }> {
    const imageMimeType = INLINE_IMAGE_MIME_TYPES.find((mime) => mime === input.mimeType);
    const type = imageMimeType === undefined ? "file" : "image";
    const created = await this.request((client) =>
      client[WS_METHODS.attachmentsCreateUploadUrl](
        imageMimeType === undefined
          ? {
              type: "file",
              name: input.name,
              mimeType: input.mimeType,
              sizeBytes: input.bytes.byteLength,
            }
          : {
              type: "image",
              name: input.name,
              mimeType: imageMimeType,
              sizeBytes: input.bytes.byteLength,
            },
      ),
    );
    const response = await fetch(new URL(created.relativeUrl, this.credentials.httpBaseUrl), {
      method: "POST",
      headers: { "content-type": input.mimeType },
      body: new Uint8Array(input.bytes),
    });
    if (!response.ok) throw new Error(`Attachment upload failed with ${response.status}`);
    return { attachmentId: created.attachmentId, type };
  }

  private async authorizedJson(path: string, init: RequestInit = {}): Promise<unknown> {
    for (const refresh of [false, true]) {
      const token = await this.credentials.getToken({ refresh });
      const response = await fetch(new URL(path, this.credentials.httpBaseUrl), {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      });
      if (response.status === 401 && !refresh) continue;
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return response.json();
    }
    throw new T3AuthError("T3 rejected the bridge's credentials.");
  }

  // ── RPC ─────────────────────────────────────────────────────────────────

  async dispatch(command: OrchestrationV2Command): Promise<{ sequence: number }> {
    return this.request((client) => client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command));
  }

  async launchThread(input: OrchestrationV2ThreadLaunchInput) {
    return this.request((client) => client[ORCHESTRATION_V2_WS_METHODS.launchThread](input));
  }

  async getThreadProjection(threadId: ThreadId) {
    return this.request((client) =>
      client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }),
    );
  }

  async request<A>(run: (client: WsClient) => Effect.Effect<A, unknown>): Promise<A> {
    const session = await this.waitForSession(30_000);
    const exit = await Effect.runPromiseExit(run(session.client));
    if (Exit.isSuccess(exit)) return exit.value;
    throw new Error(describeCause(exit.cause));
  }

  /**
   * Keeps a thread stream open across reconnects. `afterSequence` is read each time the
   * stream (re)opens so the caller resumes from the last event it handled.
   */
  subscribeThread(input: {
    readonly threadId: ThreadId;
    readonly afterSequence: () => number | undefined;
    readonly onItem: (item: OrchestrationV2ThreadStreamItem) => Promise<void>;
    readonly onError: (error: unknown) => void;
  }): () => void {
    const subscription: Subscription = {
      open: (client) => {
        const afterSequence = input.afterSequence();
        return client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId: input.threadId,
          ...(afterSequence === undefined ? {} : { afterSequence }),
        });
      },
      onItem: (item) => input.onItem(item as OrchestrationV2ThreadStreamItem),
      onError: input.onError,
      fiber: null,
    };
    this.subscriptions.add(subscription);
    if (this.session !== null) this.forkSubscription(subscription, this.session);
    return () => {
      this.subscriptions.delete(subscription);
      if (subscription.fiber !== null) Effect.runFork(Fiber.interrupt(subscription.fiber));
      subscription.fiber = null;
    };
  }

  private forkSubscription(
    subscription: Subscription,
    session: { client: WsClient; scope: Scope.Closeable },
  ) {
    // Suspended so every reopen reads the owner's latest cursor instead of replaying from the first one.
    const program = Stream.runForEach(
      Stream.suspend(() => subscription.open(session.client)),
      (item) =>
        Effect.promise(() =>
          subscription.onItem(item).catch((error: unknown) => {
            this.log.error("Handling a T3 stream item failed", error);
          }),
        ),
    ).pipe(
      Effect.tapError((error) => Effect.sync(() => subscription.onError(error))),
      Effect.ignore,
      // A stream that ends or fails on a live socket (for example a thread snapshot that could
      // not load) reopens on its own; a dead socket reopens it on reconnect instead.
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
    );
    subscription.fiber = Effect.runFork(program);
  }

  private waitForSession(timeoutMs: number): Promise<{ client: WsClient; scope: Scope.Closeable }> {
    if (this.session !== null) return Promise.resolve(this.session);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== onReady);
        reject(new Error(`Not connected to T3 (${describeStatus(this.status)})`));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        if (this.session !== null) resolve(this.session);
      };
      this.readyWaiters.push(onReady);
    });
  }

  private setStatus(status: T3ConnectionStatus) {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private async closeSession() {
    const session = this.session;
    this.session = null;
    for (const subscription of this.subscriptions) {
      if (subscription.fiber !== null) await Effect.runPromise(Fiber.interrupt(subscription.fiber));
      subscription.fiber = null;
    }
    if (session !== null) await Effect.runPromise(Scope.close(session.scope, Exit.void));
  }

  private runLoop(): Effect.Effect<void, never> {
    const self = this;
    let attempt = 0;
    const once = Effect.gen(function* () {
      self.setStatus({ state: "connecting" });
      yield* Effect.tryPromise(() => self.credentials.refreshOrigin?.() ?? Promise.resolve());
      const descriptor = yield* Effect.tryPromise(() => self.fetchDescriptor());
      if (descriptor.protocol !== ORCHESTRATION_PROTOCOL_VERSION) {
        return yield* Effect.fail(
          new Error(
            `T3 speaks protocol ${descriptor.protocol}, this bridge speaks ${ORCHESTRATION_PROTOCOL_VERSION}. Rebuild T3 Bridge.`,
          ),
        );
      }
      self.label = descriptor.label;
      const ticket = yield* Effect.tryPromise(() => self.issueTicket());
      const socketUrl = new URL("/ws", self.credentials.httpBaseUrl);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("wsTicket", ticket);
      socketUrl.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION_TEXT);

      const scope = yield* Scope.make();
      const connected = yield* Deferred.make<void>();
      const disconnected = yield* Deferred.make<void>();
      const hooks = RpcClient.ConnectionHooks.of({
        onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
        onDisconnect: Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
      });
      const protocol = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          pingTimeout: "15 seconds",
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(socketUrl.toString(), { openTimeout: "15 seconds" }).pipe(
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
            ),
            RpcSerialization.layerJson,
            Layer.succeed(RpcClient.ConnectionHooks, hooks),
          ),
        ),
      );
      const context = yield* Layer.buildWithScope(protocol, scope);
      const client = yield* makeClient.pipe(Effect.provide(context), Scope.provide(scope));
      const opened = yield* Deferred.await(connected).pipe(
        Effect.raceFirst(Deferred.await(disconnected).pipe(Effect.as("closed" as const))),
        Effect.timeoutOption("20 seconds"),
      );
      if (opened._tag === "None" || opened.value === "closed") {
        yield* Scope.close(scope, Exit.void);
        return yield* Effect.fail(new Error("T3 WebSocket did not open"));
      }

      attempt = 0;
      self.session = { client, scope };
      self.setStatus({ state: "connected", label: descriptor.label });
      self.log.info(`Connected to T3 "${descriptor.label}"`);
      for (const waiter of self.readyWaiters.splice(0)) waiter();
      for (const subscription of self.subscriptions)
        self.forkSubscription(subscription, self.session);

      yield* Deferred.await(disconnected);
      yield* Effect.promise(() => self.closeSession());
      return yield* Effect.fail(new Error("T3 connection closed"));
    });

    return once.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const message = describeCause(cause);
          self.setStatus({ state: "disconnected", error: message });
          self.log.warn(`T3 connection: ${message}`);
          yield* Effect.promise(() => self.closeSession());
          attempt += 1;
          yield* Effect.sleep(`${Math.min(30, 2 ** Math.min(attempt, 5))} seconds`);
        }),
      ),
      Effect.forever,
    );
  }

  private async issueTicket(): Promise<string> {
    const result = (await this.authorizedJson("/api/auth/websocket-ticket", {
      method: "POST",
    })) as { ticket: string };
    return result.ticket;
  }
}

function describeStatus(status: T3ConnectionStatus) {
  return status.state === "disconnected" ? status.error : status.state;
}

export function describeCause(cause: unknown): string {
  let error: unknown = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  // Effect.tryPromise wraps what was thrown; the original says what actually went wrong.
  for (
    let depth = 0;
    depth < 5 && error instanceof Error && error.cause instanceof Error;
    depth += 1
  ) {
    error = error.cause;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  return (message ?? "Unknown error").split("\n")[0]!.slice(0, 500);
}
