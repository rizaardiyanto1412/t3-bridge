import { useCallback, useEffect, useMemo, useState } from "react";

import {
  makeApi,
  adoptToken,
  pageTarget,
  type Api,
  type Bot,
  type BotStatus,
  type LogEntry,
  type ModelSelection,
  type Project,
  type Status,
  type Target,
  type ThreadSummary,
  type UpdateCheck,
  type UpdateStatus,
} from "./api.ts";

export function App() {
  const [target] = useState<Target | null>(pageTarget);
  const api = useMemo(() => (target ? makeApi(target) : null), [target]);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <BridgeMark />
          <span>T3 Bridge</span>
        </div>
      </header>
      <main className="content">
        {api && target ? <Dashboard api={api} target={target} /> : <ConnectPrompt />}
      </main>
    </div>
  );
}

function ConnectPrompt() {
  return (
    <section className="card">
      <h2>Open this page with its link</h2>
      <p className="muted">
        On the Mac running T3 Bridge, run <code>npx t3-bridge link</code> and open the link it
        prints. It looks like <code>http://100.x.y.z:47821/#token=…</code>
      </p>
    </section>
  );
}

function Dashboard({ api, target }: { api: Api; target: Target }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BotStatus | "new" | null>(null);
  const [threads, setThreads] = useState<{ projects: Project[]; threads: ThreadSummary[] } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await api.threads());
    } catch {
      // The status card already explains why T3 is unreachable.
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    void refreshThreads();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh, refreshThreads]);

  if (error && status === null) {
    return (
      <section className="card error-card">
        <h2>Can't reach {target.label}</h2>
        <p>{error}</p>
        <p className="muted">
          Check that the Mac running T3 Bridge is on and that this device is on the same Tailscale
          network.
        </p>
      </section>
    );
  }
  if (status === null) return <p className="muted">Loading…</p>;

  if (editing !== null) {
    return (
      <BotEditor
        api={api}
        bot={editing === "new" ? null : editing}
        manifestVersion={status.manifestVersion}
        threads={threads}
        reloadThreads={refreshThreads}
        onDone={() => {
          setEditing(null);
          void refresh();
          void refreshThreads();
        }}
      />
    );
  }

  const threadTitle = (id: string | null) => threads?.threads.find((thread) => thread.id === id);

  return (
    <div className="stack">
      {error && <div className="banner warn">Lost contact: {error}</div>}
      <section className="card">
        <div className="row spread">
          <div>
            <h2>T3 Code</h2>
            <p className="muted">{status.t3.label}</p>
          </div>
          <Pill
            state={
              status.t3.state === "connected"
                ? "ok"
                : status.t3.state === "connecting"
                  ? "pending"
                  : "bad"
            }
          >
            {status.t3.state === "connected"
              ? "Connected"
              : status.t3.state === "connecting"
                ? "Connecting…"
                : "Not connected"}
          </Pill>
        </div>
        {status.t3.error && <p className="error-text">{status.t3.error}</p>}
      </section>

      <section className="stack">
        <div className="row spread">
          <h2>Bots</h2>
          <button className="button primary" onClick={() => setEditing("new")}>
            Add Slack bot
          </button>
        </div>
        {status.bots.length === 0 && (
          <div className="card empty">
            <p>No bots yet.</p>
            <p className="muted">
              A bot is one Slack app talking to one T3 thread. That thread acts as the orchestrator
              and hands the real work to subagents.
            </p>
          </div>
        )}
        {status.bots.map((bot) => (
          <BotCard
            key={bot.id}
            bot={bot}
            thread={threadTitle(bot.threadId)}
            onEdit={() => setEditing(bot)}
            onToggle={async () => {
              await api.updateBot(bot.id, { enabled: !bot.enabled });
              void refresh();
            }}
            onNewThread={async () => {
              if (
                !confirm(
                  `Start a fresh orchestrator thread for ${bot.name}? It gets the same project, model and instructions; the current thread stays in T3, unpinned.`,
                )
              )
                return;
              await api.newThread(bot.id);
              void refresh();
              void refreshThreads();
            }}
            onDelete={async () => {
              if (
                !confirm(
                  `Remove ${bot.name}? The Slack app stays in Slack; T3 Bridge forgets its tokens.`,
                )
              )
                return;
              await api.removeBot(bot.id);
              void refresh();
            }}
          />
        ))}
      </section>

      <OtherDevices status={status} api={api} />
      <Updates api={api} />
      <Logs api={api} />
    </div>
  );
}

function BotCard(props: {
  bot: BotStatus;
  thread: ThreadSummary | undefined;
  onEdit: () => void;
  onToggle: () => void;
  onNewThread: () => void;
  onDelete: () => void;
}) {
  const { bot } = props;
  const state = !bot.enabled
    ? "off"
    : bot.connection.state === "connected"
      ? "ok"
      : bot.connection.state === "connecting"
        ? "pending"
        : "bad";
  return (
    <article className="card bot">
      <div className="row spread">
        <div className="row gap">
          <span className="slack-glyph" aria-hidden>
            #
          </span>
          <div>
            <h3>{bot.name}</h3>
            <p className="muted small">
              {bot.connection.identity ??
                (bot.enabled ? (bot.connection.error ?? "Connecting…") : "Turned off")}
            </p>
          </div>
        </div>
        <Pill state={state}>
          {state === "ok"
            ? "Online"
            : state === "pending"
              ? "Connecting"
              : state === "off"
                ? "Off"
                : "Problem"}
        </Pill>
      </div>
      <dl className="facts">
        <dt>Thread</dt>
        <dd>
          {bot.threadId === null ? (
            <span className="error-text">None picked</span>
          ) : props.thread ? (
            <>
              {props.thread.pinned && "📌 "}
              {props.thread.title}{" "}
              <span className="muted">
                · {props.thread.projectTitle} · {props.thread.model}
              </span>
            </>
          ) : (
            <span className="muted">{bot.threadId}</span>
          )}
        </dd>
        <dt>Allowed</dt>
        <dd>
          {bot.allowedUserIds.length === 0 ? (
            <span className="muted">Whoever DMs the bot first becomes its owner</span>
          ) : (
            bot.allowedUserIds.join(", ")
          )}
        </dd>
      </dl>
      {bot.lastError && <p className="error-text small">{bot.lastError}</p>}
      {bot.manifestOutdated && (
        <div className="banner warn small">
          New Slack features are ready: {bot.name} becomes a Slack AI app with one thread per
          request, streaming replies, "is working…" and a Stop button, plus "Send to {bot.name}" and
          canvases for long reports. Update the Slack app to turn them on.
        </div>
      )}
      <div className="row gap">
        <button
          className={bot.manifestOutdated ? "button primary" : "button"}
          onClick={props.onEdit}
        >
          {bot.manifestOutdated ? "Update Slack app" : "Edit"}
        </button>
        <button className="button" onClick={props.onToggle}>
          {bot.enabled ? "Turn off" : "Turn on"}
        </button>
        {bot.threadId !== null && (
          <button
            className="button"
            onClick={props.onNewThread}
            title="Start a fresh orchestrator thread when this one has grown long (or send !new to the bot)"
          >
            New thread
          </button>
        )}
        <button className="button ghost danger" onClick={props.onDelete}>
          Remove
        </button>
      </div>
    </article>
  );
}

function OtherDevices({ status, api }: { status: Status; api: Api }) {
  const [copied, setCopied] = useState(false);
  const link = status.connectLinks[0];
  return (
    <section className="card">
      <h2>Open from other devices</h2>
      {link ? (
        <>
          <p className="muted">
            Open this link on any device on your Tailscale network, and bookmark it. Treat it like
            a password.
          </p>
          <div className="row gap">
            <code className="link">{link.replace(/token=.*/, "token=••••••")}</code>
            <button
              className="button"
              onClick={() => {
                copyText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              className="button ghost"
              onClick={async () => {
                if (
                  !confirm(
                    "Replace the link? Every copy of the old link stops working, including bookmarks on other devices.",
                  )
                )
                  return;
                const result = await api.rotateLink();
                adoptToken(result.token);
              }}
            >
              Replace link
            </button>
          </div>
        </>
      ) : (
        <p className="muted">
          This Mac has no Tailscale address, so only this Mac can open the panel. Install
          Tailscale, then run <code>npx t3-bridge link</code>.
        </p>
      )}
    </section>
  );
}

/** Installs the newest version from npm and restarts the background service, without a terminal. */
function Updates({ api }: { api: Api }) {
  const [info, setInfo] = useState<{ supported: boolean; current: string } | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<UpdateStatus | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.updateInfo().then((result) => {
      setInfo(result);
      const status = result.status;
      if (status && (status.state === "running" || status.state === "restarting")) {
        setStartedAt(Date.parse(status.startedAt));
        setProgress(status);
      }
    });
  }, [api]);

  // While updating, T3 Bridge restarts and briefly stops answering; keep asking until the
  // new one reports the update finished, then reload to get its control panel.
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => {
      void api
        .updateInfo()
        .then((result) => {
          const status = result.status;
          if (status === null || Date.parse(status.startedAt) < startedAt - 5000) return;
          setProgress(status);
          if (status.state === "done") location.reload();
          if (status.state === "failed") setStartedAt(null);
        })
        .catch(() => setProgress((current) => current && { ...current, step: "Restarting T3 Bridge" }));
    }, 2000);
    return () => clearInterval(timer);
  }, [api, startedAt]);

  if (info === null || !info.supported) return null;

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setCheck(await api.checkUpdate());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  };

  const update = async () => {
    setError(null);
    try {
      setStartedAt(Date.now());
      setProgress({ state: "running", step: "Starting", from: "", to: null, error: null, startedAt: new Date().toISOString(), finishedAt: null });
      await api.startUpdate();
    } catch (cause) {
      setStartedAt(null);
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const updating = startedAt !== null;
  return (
    <section className="card">
      <div className="row spread">
        <div>
          <h2>Updates</h2>
          <p className="muted small">Installed: {info.current ?? "unknown"}</p>
        </div>
        {!updating && (
          <button className="button" disabled={checking} onClick={() => void runCheck()}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
      {updating && progress && (
        <p>
          ⏳ {progress.step}… <span className="muted small">The bots pause for a moment while T3 Bridge restarts.</span>
        </p>
      )}
      {!updating && progress?.state === "failed" && (
        <p className="error-text">
          The update failed: {progress.error}. Details are in update.log in ~/Library/Application Support/T3 Bridge.
        </p>
      )}
      {!updating && check && (
        <>
          {check.reason && <p className="error-text small">{check.reason}</p>}
          {!check.available ? (
            <p className="ok-text">You're on the latest version.</p>
          ) : (
            <div className="row gap">
              <p>
                Version {check.latest} is available.{" "}
                <a href="https://github.com/rizaardiyanto1412/t3-bridge/releases" target="_blank" rel="noreferrer">
                  What's new
                </a>
              </p>
              <button className="button primary" onClick={() => void update()}>
                Update now
              </button>
            </div>
          )}
        </>
      )}
      {error && <p className="error-text small">{error}</p>}
    </section>
  );
}

function Logs({ api }: { api: Api }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    const load = () => void api.logs().then((result) => setEntries(result.entries));
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [api, open]);
  return (
    <section className="card">
      <button className="disclosure" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Activity log
      </button>
      {open && (
        <pre className="log">
          {entries.length === 0
            ? "Nothing yet."
            : entries
                .slice()
                .reverse()
                .map(
                  (entry) =>
                    `${entry.at.slice(11, 19)} ${entry.level === "info" ? " " : entry.level === "warn" ? "!" : "✗"} ${entry.message}`,
                )
                .join("\n")}
        </pre>
      )}
    </section>
  );
}

// ── Add / edit a bot ──────────────────────────────────────────────────────

function BotEditor(props: {
  api: Api;
  bot: BotStatus | null;
  manifestVersion: number;
  threads: { projects: Project[]; threads: ThreadSummary[] } | null;
  reloadThreads: () => Promise<void>;
  onDone: () => void;
}) {
  const { api, bot } = props;
  const isNew = bot === null;
  const [name, setName] = useState(bot?.name ?? "");
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [tokenCheck, setTokenCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(bot?.threadId ?? null);
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [reminder, setReminder] = useState(bot?.reminder ?? true);
  const [allowed, setAllowed] = useState((bot?.allowedUserIds ?? []).join(", "));
  const [sendInstructions, setSendInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdThread, setCreatedThread] = useState(false);

  useEffect(() => {
    if (instructions === "")
      void api.defaults().then((defaults) => setInstructions(defaults.instructions));
  }, [api, instructions]);

  const testTokens = async () => {
    setTokenCheck({ ok: true, text: "Checking…" });
    try {
      const result = await api.testSlack({ botToken: botToken.trim(), appToken: appToken.trim() });
      setTokenCheck({ ok: true, text: `✓ ${result.botUser} in ${result.team}` });
    } catch (cause) {
      setTokenCheck({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const allowedUserIds = allowed
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      const tokens =
        botToken.trim() && appToken.trim()
          ? { slack: { botToken: botToken.trim(), appToken: appToken.trim() } }
          : {};
      if (isNew) {
        await api.addBot({
          name: name.trim() || "T3 Bot",
          platform: "slack",
          ...tokens,
          threadId,
          allowedUserIds,
          instructions,
          reminder,
          sendInstructions: sendInstructions && !createdThread,
        });
      } else {
        await api.updateBot(bot.id, {
          name,
          ...tokens,
          threadId,
          allowedUserIds,
          instructions,
          reminder,
          sendInstructions,
        });
      }
      props.onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const tokensReady =
    !isNew || (botToken.trim().startsWith("xoxb-") && appToken.trim().startsWith("xapp-"));

  return (
    <div className="stack">
      <div className="row gap">
        <button className="button ghost" onClick={props.onDone}>
          ← Back
        </button>
        <h2>{isNew ? "Add a Slack bot" : `Edit ${bot.name}`}</h2>
      </div>

      <section className="card step">
        <StepHeader n={1} title="Name the bot" />
        <input
          className="input"
          placeholder="e.g. Sandywp Bot"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </section>

      <section className="card step">
        <StepHeader n={2} title={isNew ? "Create the Slack app" : "Slack tokens"} />
        {isNew ? (
          <SlackSetup api={api} name={name} />
        ) : (
          <>
            {bot.manifestOutdated && (
              <SlackUpdate
                api={api}
                name={name || bot.name}
                onDone={async () => {
                  await api.updateBot(bot.id, { manifestVersion: props.manifestVersion });
                  props.onDone();
                }}
              />
            )}
            <p className="muted">Leave the tokens empty to keep the current ones.</p>
          </>
        )}
        <label className="field">
          <span>Bot token</span>
          <input
            className="input mono"
            placeholder="xoxb-…"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
          />
        </label>
        <label className="field">
          <span>App-level token</span>
          <input
            className="input mono"
            placeholder="xapp-…"
            value={appToken}
            onChange={(event) => setAppToken(event.target.value)}
          />
        </label>
        <div className="row gap">
          <button
            className="button"
            disabled={!botToken.trim() || !appToken.trim()}
            onClick={() => void testTokens()}
          >
            Test tokens
          </button>
          {tokenCheck && (
            <span className={tokenCheck.ok ? "ok-text" : "error-text"}>{tokenCheck.text}</span>
          )}
        </div>
      </section>

      <section className="card step">
        <StepHeader n={3} title="Pick the orchestrator thread" />
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
      </section>

      <section className="card step">
        <StepHeader n={4} title="Orchestrator instructions" />
        <p className="muted small">
          A new thread made here starts with these instructions. For a thread you already have, tick
          the box to send them now.
        </p>
        <textarea
          className="input mono"
          rows={9}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={reminder}
            onChange={(event) => setReminder(event.target.checked)}
          />
          <span>
            Add a one-line role reminder to every chat message, so long threads never forget it
          </span>
        </label>
        {!createdThread && threadId !== null && (
          <label className="check">
            <input
              type="checkbox"
              checked={sendInstructions}
              onChange={(event) => setSendInstructions(event.target.checked)}
            />
            <span>Send these instructions to the thread when I save</span>
          </label>
        )}
      </section>

      <section className="card step">
        <StepHeader n={5} title="Who may use it" />
        <input
          className="input mono"
          placeholder="Slack member IDs, e.g. U04ABCDEF (leave empty to claim it by DMing the bot)"
          value={allowed}
          onChange={(event) => setAllowed(event.target.value)}
        />
        <p className="muted small">
          The bot runs code on your Mac, so only these people can send it work. Left empty, the
          first person who sends the bot a direct message becomes its owner. Find a member ID in
          Slack: profile → ⋯ → Copy member ID.
        </p>
      </section>

      {error && <div className="banner error">{error}</div>}
      <div className="row gap end">
        <button className="button ghost" onClick={props.onDone}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={saving || !tokensReady || threadId === null}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : isNew ? "Add bot" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * T3 Bridge serves this page over plain http on the tailnet, where browsers withhold the
 * clipboard API; the old execCommand copy still works there.
 */
function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    void navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function useManifest(api: Api, name: string) {
  const [manifest, setManifest] = useState("");
  useEffect(() => {
    void api
      .manifest(name || "T3 Bridge")
      .then((value) => setManifest(JSON.stringify(value, null, 2)));
  }, [api, name]);
  return manifest;
}

/** The manifest itself, for selecting by hand if copying is blocked. */
function ManifestText({ manifest }: { manifest: string }) {
  return (
    <details className="manifest">
      <summary className="small muted">Show manifest</summary>
      <textarea
        className="input mono"
        rows={10}
        readOnly
        value={manifest}
        onFocus={(event) => event.currentTarget.select()}
      />
    </details>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="button small"
      disabled={!text}
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** For a bot made before the manifest last changed: new scopes and events need a reinstall. */
function SlackUpdate({
  api,
  name,
  onDone,
}: {
  api: Api;
  name: string;
  onDone: () => Promise<void>;
}) {
  const manifest = useManifest(api, name);
  const [saving, setSaving] = useState(false);
  return (
    <div className="banner warn stack tight">
      <strong>Update the Slack app to turn on the new features</strong>
      <span className="small">
        This turns the bot into a Slack AI app: each request gets its own thread, where replies
        stream in and subagents, questions and the final summary all appear together.
      </span>
      <ol className="instructions">
        <li>
          Copy the new manifest. <CopyButton text={manifest} label="Copy manifest" />
          <ManifestText manifest={manifest} />
        </li>
        <li>
          Open{" "}
          <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
            api.slack.com/apps
          </a>
          , pick <em>{name}</em>, and open <em>App Manifest</em>.
        </li>
        <li>
          Replace everything with the copied manifest and choose <em>Save Changes</em>.
        </li>
        <li>
          Slack then asks you to reinstall: choose <em>Reinstall to Workspace</em> and{" "}
          <em>Allow</em>. The tokens stay the same.
        </li>
      </ol>
      <div className="row gap">
        <button
          className="button primary small"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onDone().finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Done, I reinstalled it"}
        </button>
      </div>
    </div>
  );
}

function SlackSetup({ api, name }: { api: Api; name: string }) {
  const manifest = useManifest(api, name);
  return (
    <ol className="instructions">
      <li>
        Copy this manifest. <CopyButton text={manifest} label="Copy manifest" />
        <ManifestText manifest={manifest} />
      </li>
      <li>
        Open{" "}
        <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">
          api.slack.com/apps
        </a>{" "}
        → <em>Create New App</em> → <em>From a manifest</em>, pick your workspace, choose JSON and
        paste it.
      </li>
      <li>
        <em>Install App</em> → <em>Install to Workspace</em>, then copy the{" "}
        <strong>Bot User OAuth Token</strong> (xoxb-…).
      </li>
      <li>
        <em>Basic Information</em> → <em>App-Level Tokens</em> → <em>Generate Token and Scopes</em>,
        add the <code>connections:write</code> scope, and copy the token (xapp-…).
      </li>
      <li>
        To use the bot in a channel, invite it there: <code>/invite @{name || "your bot"}</code>.
        Direct messages work right away.
      </li>
    </ol>
  );
}

function ThreadPicker(props: {
  api: Api;
  threads: { projects: Project[]; threads: ThreadSummary[] } | null;
  value: string | null;
  instructions: string;
  onChange: (id: string, created: boolean) => void;
  reload: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [filter, setFilter] = useState("");
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("Orchestrator");
  const [models, setModels] = useState<ModelSelection[]>([]);
  const [model, setModel] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    void props.api.models(projectId).then((result) => {
      setModels(result.models);
      setModel(0);
    });
  }, [props.api, projectId]);

  if (props.threads === null) return <p className="muted">Loading threads from T3…</p>;
  const visible = props.threads.threads.filter((thread) =>
    `${thread.title} ${thread.projectTitle}`.toLowerCase().includes(filter.toLowerCase()),
  );

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const selection = models[model];
      const result = await props.api.createThread({
        projectId,
        title,
        instructions: props.instructions,
        ...(selection ? { modelSelection: selection } : {}),
      });
      await props.reload();
      props.onChange(result.threadId, true);
      setMode("existing");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="stack tight">
      <div className="segmented">
        <button className={mode === "existing" ? "active" : ""} onClick={() => setMode("existing")}>
          Use a thread I have
        </button>
        <button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>
          Create a new one
        </button>
      </div>
      {mode === "existing" ? (
        <>
          <input
            className="input"
            placeholder="Search threads"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="thread-list">
            {visible.slice(0, 60).map((thread) => (
              <button
                key={thread.id}
                className={`thread-row ${props.value === thread.id ? "selected" : ""}`}
                onClick={() => props.onChange(thread.id, false)}
              >
                <span className="thread-title">
                  {thread.pinned && "📌 "}
                  {thread.title}
                </span>
                <span className="muted small">
                  {thread.projectTitle} · {thread.model}
                </span>
              </button>
            ))}
            {visible.length === 0 && <p className="muted small">No threads match.</p>}
          </div>
        </>
      ) : (
        <div className="stack tight">
          <label className="field">
            <span>Project</span>
            <select
              className="input"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose a project…</option>
              {props.threads.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <select
              className="input"
              value={model}
              onChange={(event) => setModel(Number(event.target.value))}
              disabled={models.length === 0}
            >
              {models.length === 0 && <option>Project default</option>}
              {models.map((selection, index) => (
                <option key={`${selection.instanceId}/${selection.model}`} value={index}>
                  {selection.model} ({selection.instanceId})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Title</span>
            <input
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="muted small">
            The thread is created with full access, pinned, and given the instructions below.
          </p>
          <div className="row gap">
            <button
              className="button primary"
              disabled={!projectId || creating}
              onClick={() => void create()}
            >
              {creating ? "Creating…" : "Create and pin thread"}
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function StepHeader({ n, title }: { n: number; title: string }) {
  return (
    <div className="step-header">
      <span className="step-number">{n}</span>
      <h3>{title}</h3>
    </div>
  );
}

function Pill({
  state,
  children,
}: {
  state: "ok" | "pending" | "bad" | "off";
  children: React.ReactNode;
}) {
  return <span className={`pill ${state}`}>{children}</span>;
}

function BridgeMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 36 36" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="3.2">
        <circle cx="9" cy="18" r="6" />
        <circle cx="27" cy="18" r="6" />
        <line x1="15" y1="18" x2="21" y2="18" />
      </g>
    </svg>
  );
}
