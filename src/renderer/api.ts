export interface Target {
  readonly baseUrl: string;
  readonly token: string;
  readonly label: string;
}

const TOKEN_KEY = "t3bridge.token";

/** The panel gets its token once in the URL, then keeps it for reloads. */
export function pageTarget(): Target | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    localStorage.setItem(TOKEN_KEY, fromHash);
    history.replaceState(null, "", location.pathname + location.search);
  }
  const token = fromHash ?? localStorage.getItem(TOKEN_KEY);
  return token ? { baseUrl: location.origin, token, label: location.hostname } : null;
}

/** After the link is replaced, keep using the panel with the new token. */
export function adoptToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
  location.reload();
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function makeApi(target: Target) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok)
      throw new ApiError(response.status, json.error ?? `Request failed (${response.status})`);
    return json as T;
  };
  return {
    status: () => call<Status>("GET", "/api/status"),
    logs: () => call<{ entries: LogEntry[] }>("GET", "/api/logs"),
    defaults: () => call<{ instructions: string }>("GET", "/api/defaults"),
    threads: () =>
      call<{ projects: Project[]; threads: ThreadSummary[] }>("GET", "/api/t3/threads"),
    models: (projectId: string) =>
      call<{ models: ModelSelection[] }>(
        "GET",
        `/api/t3/models?projectId=${encodeURIComponent(projectId)}`,
      ),
    createThread: (input: {
      projectId: string;
      title: string;
      instructions: string;
      modelSelection?: ModelSelection;
    }) => call<{ threadId: string }>("POST", "/api/t3/threads", input),
    manifest: (name: string) =>
      call<unknown>("GET", `/api/slack/manifest?name=${encodeURIComponent(name)}`),
    testSlack: (tokens: { botToken: string; appToken: string }) =>
      call<{ team: string; botUser: string }>("POST", "/api/slack/test", tokens),
    testDiscord: (input: { botToken: string }) =>
      call<{ botUser: string; inviteUrl: string; messageContent: boolean }>(
        "POST",
        "/api/discord/test",
        input,
      ),
    testTelegram: (input: { botToken: string }) =>
      call<{ botUser: string; link: string }>("POST", "/api/telegram/test", input),
    addBot: (input: BotInput) => call<Bot>("POST", "/api/bots", input),
    updateBot: (id: string, patch: Partial<BotInput>) =>
      call<Bot>("PATCH", `/api/bots/${id}`, patch),
    removeBot: (id: string) => call<unknown>("DELETE", `/api/bots/${id}`),
    activity: (id: string) => call<{ entries: ActivityEntry[] }>("GET", `/api/bots/${id}/activity`),
    stop: (id: string) => call<{ stopped: boolean }>("POST", `/api/bots/${id}/stop`),
    newThread: (id: string) =>
      call<{ threadId: string; title: string }>("POST", `/api/bots/${id}/new-thread`),
    updateInfo: () =>
      call<{ supported: boolean; current: string; status: UpdateStatus | null }>(
        "GET",
        "/api/update",
      ),
    checkUpdate: () => call<UpdateCheck>("POST", "/api/update/check"),
    startUpdate: () => call<{ started: boolean }>("POST", "/api/update/start"),
    rotateLink: () =>
      call<{ token: string; connectLinks: string[] }>("POST", "/api/control/rotate"),
  };
}

export type Api = ReturnType<typeof makeApi>;

export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: unknown;
}

export interface Project {
  readonly id: string;
  readonly title: string;
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

export type Platform = "slack" | "discord" | "telegram";

export const PLATFORM_NAMES: Record<Platform, string> = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
};

export interface Bot {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly account?: { readonly username: string; readonly applicationId?: string };
  readonly enabled: boolean;
  readonly threadId: string | null;
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly instructions: string;
  readonly reminder: boolean;
  readonly manifestVersion?: number;
}

export interface BotStatus extends Bot {
  readonly connection: { state: string; identity?: string; error?: string };
  readonly lastError: string | null;
  readonly manifestOutdated: boolean;
  /** Discord's invite to a server, or the bot's t.me link. */
  readonly chatLink: string | null;
  readonly activity: {
    readonly working: ActivityEntry | null;
    readonly today: number;
    readonly problemsToday: number;
    readonly lastAt: string | null;
  };
}

export interface ActivityEntry {
  readonly id: string;
  readonly at: string;
  readonly user: string;
  readonly text: string;
  readonly files: number;
  readonly status: "running" | "completed" | "failed" | "interrupted" | "not_sent";
  readonly subagents: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>;
  readonly waiting: "approval" | "question" | null;
  readonly reply: string | null;
  readonly error: string | null;
  readonly updatedAt: string;
}

export interface BotInput {
  readonly name: string;
  readonly platform: Platform;
  readonly slack?: { botToken: string; appToken: string };
  readonly discord?: { botToken: string };
  readonly telegram?: { botToken: string };
  readonly threadId: string | null;
  readonly allowedUserIds?: ReadonlyArray<string>;
  readonly instructions?: string;
  readonly reminder?: boolean;
  readonly manifestVersion?: number;
  readonly enabled?: boolean;
  readonly sendInstructions?: boolean;
}

export interface Status {
  readonly version: string;
  readonly manifestVersion: number;
  readonly t3: {
    state: "connected" | "connecting" | "disconnected";
    label: string;
    error?: string;
  };
  readonly bots: ReadonlyArray<BotStatus>;
  readonly connectLinks: ReadonlyArray<string>;
}

export interface UpdateCheck {
  readonly available: boolean;
  readonly current: string;
  readonly latest: string | null;
  readonly reason: string | null;
}

export interface UpdateStatus {
  readonly state: "running" | "restarting" | "done" | "failed";
  readonly step: string;
  readonly from: string;
  readonly to: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface LogEntry {
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}
