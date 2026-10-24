import * as Crypto from "node:crypto";
import * as Path from "node:path";

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";

import { AGENT_LAYOUT_MANIFEST_VERSION, MANIFEST_VERSION } from "./adapters/slack/manifest.ts";
import { DiscordAdapter, discordInviteUrl, testDiscordToken } from "./adapters/discord/DiscordAdapter.ts";
import { SlackAdapter, testSlackTokens } from "./adapters/slack/SlackAdapter.ts";
import { TelegramAdapter, testTelegramToken } from "./adapters/telegram/TelegramAdapter.ts";
import { isWorking, type ActivityEntry } from "./core/activity.ts";
import { BotRuntime } from "./core/BotRuntime.ts";
import { ButtonStore } from "./core/ButtonStore.ts";
import { DEFAULT_INSTRUCTIONS } from "./core/render.ts";
import type { ChatAdapter } from "./core/types.ts";
import { makeLogger } from "./log.ts";
import {
  ConfigStore,
  readJson,
  writeJsonAtomic,
  type BotConfig,
  type BridgeConfig,
  type Platform,
  type SecretStore,
} from "./store.ts";
import { makeLocalCredentials, type LocalEnvironmentOptions } from "./t3/localEnvironment.ts";
import { T3Client, type T3ConnectionStatus } from "./t3/T3Client.ts";
import { BRIDGE_VERSION } from "./version.ts";

export interface EngineOptions {
  readonly dataDir: string;
  readonly secrets: SecretStore;
  readonly t3Defaults?: LocalEnvironmentOptions;
  readonly controlPort?: number;
  readonly logSink?: (line: string) => void;
  /** Replaces the chat platform, for tests. */
  readonly makeAdapter?: (bot: BotConfig) => ChatAdapter;
}

export interface BotInput {
  readonly name: string;
  readonly platform: Platform;
  readonly slack?: { readonly botToken: string; readonly appToken: string };
  readonly discord?: { readonly botToken: string };
  readonly telegram?: { readonly botToken: string };
  readonly threadId: string | null;
  readonly allowedUserIds?: ReadonlyArray<string>;
  readonly instructions?: string;
  readonly reminder?: boolean;
  readonly manifestVersion?: number;
  readonly enabled?: boolean;
  /** Send the instructions to the thread now, for a thread that was not created by the bridge. */
  readonly sendInstructions?: boolean;
}

export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly pinned: boolean;
  readonly status: string;
  readonly model: string;
  readonly updatedAt: string;
}

const botSecret = (botId: string, name: string) => `bot.${botId}.${name}`;

const PLATFORM_LABELS: Record<Platform, string> = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
};

export class Engine {
  readonly log;
  readonly config: ConfigStore;
  t3!: T3Client;
  private readonly bots = new Map<string, BotRuntime>();
  private bridgeMessages = new Set<string>();

  private readonly options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
    this.log = makeLogger(options.logSink);
    this.config = new ConfigStore(options.dataDir);
  }

  private get bridgeMessagesFile() {
    return Path.join(this.options.dataDir, "bridge-messages.json");
  }

  async start(): Promise<BridgeConfig> {
    const config = await this.config.load({
      ...(this.options.controlPort === undefined ? {} : { controlPort: this.options.controlPort }),
      t3: this.options.t3Defaults ?? {},
    });
    this.bridgeMessages = new Set((await readJson<string[]>(this.bridgeMessagesFile)) ?? []);
    const credentials = await makeLocalCredentials(config.t3, this.options.secrets);
    this.t3 = new T3Client(credentials, this.log);
    this.t3.start();
    for (const bot of config.bots) await this.startBot(bot);
    this.log.info(`T3 Bridge ${BRIDGE_VERSION} started with ${config.bots.length} bot(s)`);
    return config;
  }

  async stop(): Promise<void> {
    for (const runtime of this.bots.values()) await runtime.stop().catch(() => {});
    this.bots.clear();
    await this.t3?.stop();
  }

  // ── status ──────────────────────────────────────────────────────────────

  status() {
    const config = this.config.get();
    return {
      version: BRIDGE_VERSION,
      manifestVersion: MANIFEST_VERSION,
      t3: describeT3Status(this.t3.status, this.t3.label),
      bots: config.bots.map((bot) => {
        const runtime = this.bots.get(bot.id);
        return {
          ...publicBot(bot),
          connection: runtime?.adapterStatus ?? {
            state: bot.enabled ? "error" : "disabled",
            error: "Not running",
          },
          lastError: runtime?.lastError ?? null,
          manifestOutdated: bot.platform === "slack" && (bot.manifestVersion ?? 1) < MANIFEST_VERSION,
          chatLink: chatLink(bot),
          activity: summarize(runtime?.activity ?? []),
        };
      }),
    };
  }

  /** A bot's latest requests, newest first. */
  activity(botId: string): ReadonlyArray<ActivityEntry> {
    if (!this.config.get().bots.some((bot) => bot.id === botId)) throw new NotFoundError("No such bot");
    return [...(this.bots.get(botId)?.activity ?? [])].reverse();
  }

  // ── T3 threads ──────────────────────────────────────────────────────────

  async listThreads(): Promise<{
    projects: Array<{ id: string; title: string }>;
    threads: ThreadSummary[];
  }> {
    const shell: OrchestrationV2ShellSnapshot = await this.t3.getShell();
    const projects = new Map(shell.projects.map((project) => [project.id, project.title]));
    const threads = shell.threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.lineage.relationshipToParent !== "subagent",
      )
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        projectTitle: projects.get(thread.projectId) ?? "Project",
        pinned: thread.pinnedAt != null,
        status: thread.status,
        model: thread.modelSelection.model,
        updatedAt: String(thread.updatedAt),
      }))
      .sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.updatedAt.localeCompare(left.updatedAt),
      );
    return {
      projects: shell.projects.map((project) => ({ id: project.id, title: project.title })),
      threads,
    };
  }

  /** Models already in use in a project, newest first, to offer when creating an orchestrator. */
  async modelChoices(projectId: string): Promise<ModelSelection[]> {
    const shell = await this.t3.getShell();
    const project = shell.projects.find((candidate) => candidate.id === projectId);
    const seen = new Map<string, ModelSelection>();
    if (project?.defaultModelSelection)
      seen.set(modelKey(project.defaultModelSelection), project.defaultModelSelection);
    const threads = [...shell.threads].sort((left, right) =>
      String(right.updatedAt).localeCompare(String(left.updatedAt)),
    );
    for (const thread of threads) {
      if (!seen.has(modelKey(thread.modelSelection)))
        seen.set(modelKey(thread.modelSelection), thread.modelSelection);
    }
    return [...seen.values()].slice(0, 12);
  }

  /** Creates and pins an orchestrator thread whose first message is the instructions. */
  async createOrchestratorThread(input: {
    readonly projectId: string;
    readonly title: string;
    readonly instructions?: string;
    readonly modelSelection?: ModelSelection;
  }): Promise<{ threadId: string }> {
    const shell = await this.t3.getShell();
    const project = shell.projects.find((candidate) => candidate.id === input.projectId);
    if (project === undefined) throw new Error("That project no longer exists in T3.");
    const modelSelection =
      input.modelSelection ??
      project.defaultModelSelection ??
      shell.threads.find((thread) => thread.projectId === input.projectId)?.modelSelection ??
      shell.threads[0]?.modelSelection;
    if (modelSelection === undefined)
      throw new Error("Pick a model: this project has no default model yet.");
    const messageId = MessageId.make(Crypto.randomUUID());
    await this.rememberBridgeMessage(messageId);
    const launched = await this.t3.launchThread({
      commandId: CommandId.make(Crypto.randomUUID()),
      creationSource: "mobile",
      projectId: ProjectId.make(input.projectId),
      title: input.title.trim() || "Orchestrator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId,
        text: input.instructions?.trim() || DEFAULT_INSTRUCTIONS,
        attachments: [],
      },
    });
    await this.t3
      .dispatch({
        type: "thread.pin",
        commandId: CommandId.make(Crypto.randomUUID()),
        threadId: launched.threadId,
      })
      .catch((error: unknown) => this.log.warn("Pinning the new thread failed", error));
    return { threadId: launched.threadId };
  }

  private async sendInstructions(threadId: string, instructions: string) {
    const messageId = MessageId.make(Crypto.randomUUID());
    await this.rememberBridgeMessage(messageId);
    await this.t3.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(Crypto.randomUUID()),
      createdBy: "user",
      creationSource: "mobile",
      threadId: ThreadId.make(threadId),
      messageId,
      text: instructions,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
  }

  private async rememberBridgeMessage(messageId: string) {
    this.bridgeMessages.add(messageId);
    await writeJsonAtomic(this.bridgeMessagesFile, [...this.bridgeMessages].slice(-500));
  }

  // ── bots ────────────────────────────────────────────────────────────────

  async addBot(input: BotInput) {
    const id = Crypto.randomUUID();
    if (!(input.platform in PLATFORM_LABELS)) throw new Error(`Unknown platform ${input.platform}`);
    const saved =
      this.options.makeAdapter === undefined
        ? await this.saveCredentials(id, input.platform, input)
        : {};
    if (saved === null) throw new Error(`${PLATFORM_LABELS[input.platform]} bots need a token.`);
    const bot: BotConfig = {
      id,
      name: input.name.trim() || "T3 Bot",
      platform: input.platform,
      ...(saved.account ? { account: saved.account } : {}),
      enabled: input.enabled ?? true,
      threadId: input.threadId,
      allowedUserIds: input.allowedUserIds ?? [],
      instructions: input.instructions?.trim() || DEFAULT_INSTRUCTIONS,
      reminder: input.reminder ?? true,
      ...(input.platform === "slack" ? { manifestVersion: MANIFEST_VERSION } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.config.update((config) => ({ ...config, bots: [...config.bots, bot] }));
    if (input.sendInstructions && bot.threadId !== null)
      await this.sendInstructions(bot.threadId, bot.instructions);
    await this.startBot(bot);
    return publicBot(bot);
  }

  async updateBot(id: string, patch: Partial<BotInput>) {
    const current = this.config.get().bots.find((bot) => bot.id === id);
    if (current === undefined) throw new NotFoundError("No such bot");
    const saved = await this.saveCredentials(id, current.platform, patch);
    const next: BotConfig = {
      ...current,
      ...(saved?.account ? { account: saved.account } : {}),
      ...(patch.name === undefined ? {} : { name: patch.name.trim() || current.name }),
      ...(patch.threadId === undefined ? {} : { threadId: patch.threadId }),
      ...(patch.allowedUserIds === undefined
        ? {}
        : { allowedUserIds: patch.allowedUserIds.map((value) => value.trim()).filter(Boolean) }),
      ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
      ...(patch.reminder === undefined ? {} : { reminder: patch.reminder }),
      ...(patch.manifestVersion === undefined ? {} : { manifestVersion: patch.manifestVersion }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    };
    await this.replaceBot(next);
    if (patch.sendInstructions && next.threadId !== null)
      await this.sendInstructions(next.threadId, next.instructions);
    return publicBot(next);
  }

  /** A new orchestrator thread in the same project, with the same model and instructions. */
  async createFreshThread(botId: string): Promise<{ threadId: string; title: string }> {
    const bot = this.config.get().bots.find((candidate) => candidate.id === botId);
    if (bot === undefined) throw new NotFoundError("No such bot");
    const shell = await this.t3.getShell();
    const current = shell.threads.find((thread) => thread.id === bot.threadId);
    if (current === undefined)
      throw new Error("The bot's current thread is gone; pick one in T3 Bridge.");
    const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const title = `${bot.name} orchestrator · ${day}`;
    const { threadId } = await this.createOrchestratorThread({
      projectId: current.projectId,
      title,
      instructions: bot.instructions,
      modelSelection: current.modelSelection,
    });
    return { threadId, title };
  }

  /** Moves a bot to another thread; the one it leaves is unpinned so the pinned list stays current. */
  async switchThread(botId: string, threadId: string) {
    const previous = this.config.get().bots.find((bot) => bot.id === botId)?.threadId ?? null;
    await this.updateBot(botId, { threadId });
    if (previous !== null && previous !== threadId) {
      await this.t3
        .dispatch({
          type: "thread.unpin",
          commandId: CommandId.make(Crypto.randomUUID()),
          threadId: ThreadId.make(previous),
        })
        .catch((error: unknown) =>
          this.log.warn("Unpinning the old orchestrator thread failed", error),
        );
    }
  }

  async startFreshThread(botId: string) {
    const fresh = await this.createFreshThread(botId);
    await this.switchThread(botId, fresh.threadId);
    return fresh;
  }

  /** Replaces the control panel token; every link copied before stops working. */
  async rotateControlToken(): Promise<string> {
    const token = Crypto.randomBytes(24).toString("base64url");
    await this.config.update((config) => ({ ...config, controlToken: token }));
    this.log.info("Control panel link replaced; old links no longer work");
    return token;
  }

  async removeBot(id: string) {
    await this.bots.get(id)?.stop();
    this.bots.delete(id);
    await this.config.update((config) => ({
      ...config,
      bots: config.bots.filter((bot) => bot.id !== id),
    }));
    await this.options.secrets.delete(botSecret(id, "botToken"));
    await this.options.secrets.delete(botSecret(id, "appToken"));
  }

  /**
   * Checks and stores a bot's token(s) when the input carries them for its platform, with the
   * account they belong to (Slack keeps none). Null when the input has no tokens.
   */
  private async saveCredentials(
    id: string,
    platform: Platform,
    input: Partial<BotInput>,
  ): Promise<{ readonly account?: NonNullable<BotConfig["account"]> } | null> {
    const secrets = this.options.secrets;
    if (platform === "slack" && input.slack) {
      await testSlackTokens(input.slack);
      await secrets.set(botSecret(id, "botToken"), input.slack.botToken.trim());
      await secrets.set(botSecret(id, "appToken"), input.slack.appToken.trim());
      return {};
    }
    if (platform === "discord" && input.discord) {
      const checked = await testDiscordToken(input.discord);
      await secrets.set(botSecret(id, "botToken"), input.discord.botToken.trim());
      return { account: { username: checked.botUser, applicationId: checked.applicationId } };
    }
    if (platform === "telegram" && input.telegram) {
      const checked = await testTelegramToken(input.telegram);
      await secrets.set(botSecret(id, "botToken"), input.telegram.botToken.trim());
      return { account: { username: checked.botUser } };
    }
    return null;
  }

  private async replaceBot(next: BotConfig) {
    await this.config.update((config) => ({
      ...config,
      bots: config.bots.map((bot) => (bot.id === next.id ? next : bot)),
    }));
    await this.bots
      .get(next.id)
      ?.stop()
      .catch(() => {});
    this.bots.delete(next.id);
    await this.startBot(next);
  }

  private async startBot(bot: BotConfig) {
    if (!bot.enabled) return;
    const adapter = await this.makeAdapter(bot);
    if (adapter === null) return;
    const runtime = new BotRuntime({
      bot,
      adapter,
      t3: this.t3,
      dataDir: this.options.dataDir,
      log: this.log,
      platformLabel: PLATFORM_LABELS[bot.platform],
      claimOwner: async (userId) => {
        const latest = this.config.get().bots.find((candidate) => candidate.id === bot.id);
        if (latest === undefined || latest.allowedUserIds.length > 0) return;
        this.log.info(`[${bot.name}] claimed by ${userId}`);
        await this.config.update((config) => ({
          ...config,
          bots: config.bots.map((candidate) =>
            candidate.id === bot.id ? { ...candidate, allowedUserIds: [userId] } : candidate,
          ),
        }));
        // The runtime reads allowed users from its own copy; keep it in step without a restart.
        (runtime.bot as { allowedUserIds: ReadonlyArray<string> }).allowedUserIds = [userId];
      },
      isBridgeMessage: (messageId) => this.bridgeMessages.has(messageId),
      threaded: isAgentLayout(bot),
      createFreshThread: () => this.createFreshThread(bot.id),
      switchThread: (threadId) => this.switchThread(bot.id, threadId),
    });
    this.bots.set(bot.id, runtime);
    try {
      await runtime.start();
    } catch (error) {
      this.log.error(`[${bot.name}] could not start`, error);
      runtime.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async makeAdapter(bot: BotConfig): Promise<ChatAdapter | null> {
    if (this.options.makeAdapter) return this.options.makeAdapter(bot);
    const botToken = await this.options.secrets.get(botSecret(bot.id, "botToken"));
    if (bot.platform !== "slack") {
      if (!botToken) {
        this.log.warn(`[${bot.name}] has no ${PLATFORM_LABELS[bot.platform]} token; add it in T3 Bridge.`);
        return null;
      }
      const buttons = new ButtonStore(
        Path.join(this.options.dataDir, "state", `${bot.id}.buttons.json`),
      );
      return bot.platform === "discord"
        ? new DiscordAdapter(botToken, this.log, bot.name, buttons)
        : new TelegramAdapter(botToken, this.log, bot.name, buttons);
    }
    const appToken = await this.options.secrets.get(botSecret(bot.id, "appToken"));
    if (!botToken || !appToken) {
      this.log.warn(`[${bot.name}] has no Slack tokens; add them in T3 Bridge.`);
      return null;
    }
    return new SlackAdapter({ botToken, appToken }, this.log, bot.name, isAgentLayout(bot));
  }
}

export class NotFoundError extends Error {}

/** What the bot list shows: the request in progress, and how today went. */
function summarize(activity: ReadonlyArray<ActivityEntry>) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = activity.filter((entry) => Date.parse(entry.at) >= midnight.getTime());
  return {
    working: activity.findLast(isWorking) ?? null,
    today: today.length,
    problemsToday: today.filter((entry) => entry.error !== null || entry.status === "failed").length,
    lastAt: activity.at(-1)?.updatedAt ?? null,
  };
}

/** Bots set up with the agent manifest talk in Slack's AI-app layout, one thread per request. */
function isAgentLayout(bot: BotConfig) {
  return bot.platform === "slack" && (bot.manifestVersion ?? 1) >= AGENT_LAYOUT_MANIFEST_VERSION;
}

/** Where people find the bot: Discord's invite to a server, Telegram's t.me link. */
function chatLink(bot: BotConfig): string | null {
  if (bot.platform === "discord" && bot.account?.applicationId)
    return discordInviteUrl(bot.account.applicationId);
  if (bot.platform === "telegram" && bot.account?.username)
    return `https://t.me/${bot.account.username}`;
  return null;
}

function publicBot(bot: BotConfig) {
  return bot;
}

function modelKey(selection: ModelSelection) {
  return `${selection.instanceId}/${selection.model}`;
}

function describeT3Status(status: T3ConnectionStatus, label: string) {
  if (status.state === "connected") return { state: "connected" as const, label };
  if (status.state === "connecting") return { state: "connecting" as const, label };
  return { state: "disconnected" as const, label, error: status.error };
}
