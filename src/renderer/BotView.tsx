import { useEffect, useState } from "react";

import { PLATFORM_NAMES, type ActivityEntry, type Api, type BotStatus } from "./api.ts";
import {
  ago,
  botHealth,
  errorText,
  go,
  HEALTH_LABEL,
  ManifestText,
  PlatformIcon,
  ThreadPicker,
  useManifest,
  type Threads,
} from "./shared.tsx";

type Tab = "conversation" | "settings" | "platform";

const PLATFORM_TAB = { slack: "Slack app", discord: "Discord bot", telegram: "Telegram bot" } as const;

/** Where people find their user id, for the list of who may use the bot. */
const USER_ID_HINT = {
  slack: "Slack member IDs (profile → ⋯ → Copy member ID)",
  discord: "Discord user IDs (turn on Developer Mode, then right-click a person → Copy User ID)",
  telegram: "Telegram user IDs (numbers; the bot tells people theirs when it turns them away)",
} as const;

export function BotView(props: {
  api: Api;
  bot: BotStatus;
  manifestVersion: number;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  onChanged: () => void;
}) {
  const { api, bot } = props;
  const [tab, setTab] = useState<Tab>(bot.manifestOutdated ? "platform" : "conversation");
  const thread = props.threads?.threads.find((candidate) => candidate.id === bot.threadId);
  const health = botHealth(bot);

  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost icon back" onClick={() => go({ page: "home" })} aria-label="Back">
          ←
        </button>
        <PlatformIcon platform={bot.platform} large />
        <div className="grow">
          <h1>{bot.name}</h1>
          <div className="subtitle">
            <span className="row" style={{ gap: 5 }}>
              <span className={`dot ${health}`} />
              {health === "ok" ? (bot.connection.identity ?? HEALTH_LABEL.ok) : HEALTH_LABEL[health]}
            </span>
            <span>·</span>
            {bot.threadId === null ? (
              <span className="error-text">No thread picked</span>
            ) : (
              <span>
                {thread ? `${thread.title} · ${thread.projectTitle} · ${thread.model}` : "Thread"}
              </span>
            )}
          </div>
        </div>
        <BotMenu api={api} bot={bot} onChanged={props.onChanged} reloadThreads={props.reloadThreads} />
      </div>

      <div className="tabs">
        {(
          [
            ["conversation", "Conversation"],
            ["settings", "Settings"],
            ["platform", `${PLATFORM_TAB[bot.platform]}${bot.manifestOutdated ? " •" : ""}`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {health === "bad" && bot.connection.error && <div className="banner bad" style={{ marginBottom: 12 }}>{bot.connection.error}</div>}
      {bot.lastError && health !== "bad" && (
        <div className="banner bad" style={{ marginBottom: 12 }}>
          {bot.lastError}
        </div>
      )}

      {tab === "conversation" && <Conversation api={api} bot={bot} onUpdateSlack={() => setTab("platform")} />}
      {tab === "settings" && (
        <BotSettings
          api={api}
          bot={bot}
          threads={props.threads}
          reloadThreads={props.reloadThreads}
          onSaved={props.onChanged}
        />
      )}
      {tab === "platform" && bot.platform === "slack" && (
        <SlackTab api={api} bot={bot} manifestVersion={props.manifestVersion} onSaved={props.onChanged} />
      )}
      {tab === "platform" && bot.platform !== "slack" && (
        <TokenTab api={api} bot={bot} onSaved={props.onChanged} />
      )}
    </div>
  );
}

function BotMenu(props: { api: Api; bot: BotStatus; onChanged: () => void; reloadThreads: () => Promise<void> }) {
  const { api, bot } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  const act = (run: () => Promise<unknown>) => () => {
    setOpen(false);
    void run()
      .then(props.onChanged)
      .catch((cause: unknown) => alert(errorText(cause)));
  };
  return (
    <div className="menu" onClick={(event) => event.stopPropagation()}>
      <button className="btn icon" onClick={() => setOpen(!open)} aria-label="More">
        ⋯
      </button>
      {open && (
        <div className="menu-list">
          {bot.threadId !== null && (
            <button
              onClick={act(async () => {
                if (!confirm(`Start a fresh orchestrator thread for ${bot.name}? It gets the same project, model and instructions; the current thread stays in T3, unpinned.`)) return;
                await api.newThread(bot.id);
                await props.reloadThreads();
              })}
            >
              New thread
            </button>
          )}
          <button onClick={act(() => api.updateBot(bot.id, { enabled: !bot.enabled }))}>
            {bot.enabled ? "Turn off" : "Turn on"}
          </button>
          <button
            className="danger"
            onClick={act(async () => {
              if (!confirm(`Remove ${bot.name}? The bot stays in ${PLATFORM_NAMES[bot.platform]}; T3 Bridge forgets its token.`)) return;
              await api.removeBot(bot.id);
              go({ page: "home" });
            })}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

// ── conversation ──────────────────────────────────────────────────────────

function Conversation({ api, bot, onUpdateSlack }: { api: Api; bot: BotStatus; onUpdateSlack: () => void }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  useEffect(() => {
    const load = () => void api.activity(bot.id).then((result) => setEntries(result.entries)).catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [api, bot.id]);

  const working = bot.activity.working;
  const runningTasks = working?.subagents.filter((task) => task.status === "running" || task.status === "waiting").length ?? 0;
  return (
    <>
      {bot.manifestOutdated && (
        <div className="banner warn row spread wrap" style={{ marginBottom: 14 }}>
          <span>A new version needs more Slack permissions for this bot.</span>
          <button className="btn sm" onClick={onUpdateSlack}>
            Update Slack app
          </button>
        </div>
      )}
      <div className="facts">
        <div className="fact">
          <div className="k">Today</div>
          <div className="v">
            {bot.activity.today} request{bot.activity.today === 1 ? "" : "s"}
          </div>
        </div>
        <div className="fact">
          <div className="k">Now</div>
          <div className="v">
            {working === null ? "Idle" : runningTasks > 0 ? `${runningTasks} subagent${runningTasks === 1 ? "" : "s"} running` : working.waiting ? "Waiting for you" : "Working"}
          </div>
        </div>
        <div className="fact">
          <div className="k">Problems today</div>
          <div className={`v${bot.activity.problemsToday > 0 ? " error-text" : ""}`}>
            {bot.activity.problemsToday === 0 ? "None" : bot.activity.problemsToday}
          </div>
        </div>
      </div>
      {entries === null ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="empty">
          Nothing yet. Message {bot.name} in {PLATFORM_NAMES[bot.platform]} and the conversation shows up here.
          {bot.allowedUserIds.length === 0 && (
            <>
              <br />
              The first person to send it a direct message becomes its owner.
            </>
          )}
        </div>
      ) : (
        <div className="feed">
          {entries.map((entry) => (
            <Request key={entry.id} entry={entry} botName={bot.name} platform={PLATFORM_NAMES[bot.platform]} />
          ))}
        </div>
      )}
    </>
  );
}

function Request({ entry, botName, platform }: { entry: ActivityEntry; botName: string; platform: string }) {
  const done = entry.subagents.filter((task) => task.status === "completed").length;
  const active = entry.status === "running" || entry.subagents.some((task) => ["pending", "running", "waiting"].includes(task.status));
  const state = entry.error
    ? { tone: "bad", text: entry.error }
    : entry.waiting === "approval"
      ? { tone: "waiting", text: `Waiting for your approval in ${platform}` }
      : entry.waiting === "question"
        ? { tone: "waiting", text: `Waiting for your answer in ${platform}` }
        : active
          ? { tone: "working", text: "Working" }
          : entry.status === "failed"
            ? { tone: "bad", text: "Failed" }
            : entry.status === "interrupted"
              ? { tone: "", text: "Stopped" }
              : { tone: "ok", text: "Done" };
  return (
    <div className="req">
      <div className="msg">
        <div className="avatar">{entry.user.slice(0, 1).toUpperCase()}</div>
        <div className="bubble">
          <div className="who">
            {entry.user}
            {entry.files > 0 && ` · ${entry.files} file${entry.files === 1 ? "" : "s"}`} · {ago(entry.at)}
            {ago(entry.at) === "now" ? "" : " ago"}
          </div>
          <div className="text">{entry.text || <span className="muted">(attachments only)</span>}</div>
          <div className="chips">
            {entry.subagents.length > 0 && (
              <span className="muted small">
                {done}/{entry.subagents.length} subagents
              </span>
            )}
            {entry.subagents.map((task) => (
              <span key={task.id} className={`chip ${task.status}`} title={task.status}>
                {task.status === "completed" ? "✓ " : task.status === "failed" ? "✗ " : ""}
                {task.title}
              </span>
            ))}
            <span className={`state ${state.tone}`}>
              {state.tone === "working" && <span className="dot working" />}
              {state.text}
            </span>
          </div>
        </div>
      </div>
      {entry.reply && (
        <div className="msg">
          <div className="avatar bot">{botName.slice(0, 1).toUpperCase()}</div>
          <div className="bubble reply">
            <div className="who">{botName}</div>
            <div className="text">{entry.reply}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── settings ──────────────────────────────────────────────────────────────

function BotSettings(props: {
  api: Api;
  bot: BotStatus;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  onSaved: () => void;
}) {
  const { api, bot } = props;
  const [name, setName] = useState(bot.name);
  const [threadId, setThreadId] = useState<string | null>(bot.threadId);
  const [createdThread, setCreatedThread] = useState(false);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [reminder, setReminder] = useState(bot.reminder);
  const [allowed, setAllowed] = useState(bot.allowedUserIds.join(", "));
  const [sendInstructions, setSendInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.updateBot(bot.id, {
        name: name.trim() || bot.name,
        threadId,
        allowedUserIds: allowed.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
        instructions,
        reminder,
        sendInstructions: sendInstructions && !createdThread,
      });
      setSendInstructions(false);
      setMessage({ ok: true, text: "Saved" });
      props.onSaved();
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="field">
        <span>Orchestrator thread</span>
        <ThreadPicker
          api={api}
          threads={props.threads}
          value={threadId}
          instructions={instructions}
          onChange={(id, created) => {
            setThreadId(id);
            setCreatedThread(created);
          }}
          reload={props.reloadThreads}
        />
      </div>
      <label className="field">
        <span>
          Who may use it <span className="hint">· {USER_ID_HINT[bot.platform]}</span>
        </span>
        <input
          className="input mono"
          placeholder="Empty: the first person to DM the bot becomes its owner"
          value={allowed}
          onChange={(event) => setAllowed(event.target.value)}
        />
      </label>
      <label className="field">
        <span>
          Instructions <span className="hint">· a new thread starts with these</span>
        </span>
        <textarea className="input mono" rows={8} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={reminder} onChange={(event) => setReminder(event.target.checked)} />
        <span>Add a one-line role reminder to every message, so a long thread never forgets it</span>
      </label>
      {!createdThread && threadId !== null && (
        <label className="check">
          <input type="checkbox" checked={sendInstructions} onChange={(event) => setSendInstructions(event.target.checked)} />
          <span>Send the instructions to the thread now</span>
        </label>
      )}
      <div className="row">
        <button className="btn primary" disabled={saving || threadId === null} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        {message && <span className={message.ok ? "ok-text small" : "error-text small"}>{message.text}</span>}
      </div>
    </div>
  );
}

// ── Slack app ─────────────────────────────────────────────────────────────

function SlackTab(props: { api: Api; bot: BotStatus; manifestVersion: number; onSaved: () => void }) {
  const { api, bot } = props;
  const manifest = useManifest(api, bot.name);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const markUpdated = async () => {
    setBusy(true);
    try {
      await api.updateBot(bot.id, { manifestVersion: props.manifestVersion });
      props.onSaved();
    } finally {
      setBusy(false);
    }
  };

  const replaceTokens = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const slack = { botToken: botToken.trim(), appToken: appToken.trim() };
      const result = await api.testSlack(slack);
      await api.updateBot(bot.id, { slack });
      setBotToken("");
      setAppToken("");
      setMessage({ ok: true, text: `✓ Now ${result.botUser} in ${result.team}` });
      props.onSaved();
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {bot.manifestOutdated ? (
        <div className="card stack tight">
          <h2>Update the Slack app</h2>
          <p className="muted small" style={{ margin: 0 }}>
            The new version turns the bot into a Slack AI app: each request gets its own thread
            with streaming replies, "is working…", a Stop button and canvases for long reports.
          </p>
          <ol className="steps-list">
            <li>
              Open{" "}
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
                api.slack.com/apps
              </a>
              , pick <b>{bot.name}</b>, and open <b>App Manifest</b>.
            </li>
            <li>
              Replace everything with the new manifest and choose <b>Save Changes</b>.
              {manifest && <ManifestText text={manifest.text} />}
            </li>
            <li>
              Choose <b>Reinstall to Workspace</b> and <b>Allow</b>. The tokens stay the same.
            </li>
          </ol>
          <div>
            <button className="btn primary" disabled={busy} onClick={() => void markUpdated()}>
              Done, I reinstalled it
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>Slack app</h2>
          <p className="muted small">
            {bot.connection.identity ?? HEALTH_LABEL[botHealth(bot)]} · up to date with this version
            of T3 Bridge. To use the bot in a channel, invite it there with{" "}
            <code>/invite @{bot.name}</code>.
          </p>
        </div>
      )}
      <div className="card stack tight">
        <h2>Replace tokens</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Only needed if you regenerated them in Slack or moved the bot to another Slack app.
        </p>
        <input className="input mono" placeholder="Bot token, xoxb-…" value={botToken} onChange={(event) => setBotToken(event.target.value)} />
        <input className="input mono" placeholder="App-level token, xapp-…" value={appToken} onChange={(event) => setAppToken(event.target.value)} />
        <div className="row">
          <button
            className="btn"
            disabled={busy || !botToken.trim().startsWith("xoxb-") || !appToken.trim().startsWith("xapp-")}
            onClick={() => void replaceTokens()}
          >
            Check and save
          </button>
          {message && <span className={message.ok ? "ok-text small" : "error-text small"}>{message.text}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Discord and Telegram bots ─────────────────────────────────────────────

function TokenTab(props: { api: Api; bot: BotStatus; onSaved: () => void }) {
  const { api, bot } = props;
  const platform = bot.platform as "discord" | "telegram";
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const replaceToken = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const input = { botToken: token.trim() };
      const result = platform === "discord" ? await api.testDiscord(input) : await api.testTelegram(input);
      await api.updateBot(bot.id, { [platform]: input });
      setToken("");
      setMessage({ ok: true, text: `✓ Now ${result.botUser}` });
      props.onSaved();
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="card stack tight">
        <h2>{PLATFORM_TAB[platform]}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {bot.connection.identity ?? HEALTH_LABEL[botHealth(bot)]}.
        </p>
        {platform === "discord" ? (
          <p className="small" style={{ margin: 0 }}>
            People can message the bot once it shares a server with them. In a channel, mention it
            (<code>@{bot.account?.username ?? bot.name}</code>) or reply to one of its messages.
            {bot.chatLink && (
              <>
                {" "}
                <a href={bot.chatLink} target="_blank" rel="noreferrer">
                  Add it to a server ↗
                </a>
              </>
            )}
          </p>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            Message the bot directly, or add it to a group and mention it or reply to its messages.
            {bot.chatLink && (
              <>
                {" "}
                <a href={bot.chatLink} target="_blank" rel="noreferrer">
                  Open in Telegram ↗
                </a>
              </>
            )}
          </p>
        )}
      </div>
      <div className="card stack tight">
        <h2>Replace token</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {platform === "discord"
            ? "Only needed if you reset the token in the Discord developer portal."
            : "Only needed if you revoked the token with @BotFather."}
        </p>
        <input
          className="input mono"
          placeholder={platform === "discord" ? "Bot token" : "123456:ABC…"}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="row">
          <button className="btn" disabled={busy || token.trim().length < 20} onClick={() => void replaceToken()}>
            Check and save
          </button>
          {message && <span className={message.ok ? "ok-text small" : "error-text small"}>{message.text}</span>}
        </div>
      </div>
    </div>
  );
}
