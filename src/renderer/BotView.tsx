import { ArrowUpRight, Check, CircleAlert, CircleCheck, Pin, Plus, Send, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { PLATFORM_NAMES, type Api, type BotStatus, type Status } from "./api.ts";
import {
  botHandle,
  botState,
  Checkbox,
  errorText,
  go,
  ManifestText,
  openLink,
  PlatformBadge,
  SelectBox,
  StatePill,
  Switch,
  ThreadOptions,
  threadMeta,
  TopNav,
  useManifest,
  type Threads,
} from "./shared.tsx";

const PLATFORM_CARD = { slack: "Slack app", discord: "Discord bot", telegram: "Telegram bot" } as const;

/** Where people find their user id, for the list of who may use the bot. */
const USER_ID_HINT = {
  slack: "Slack member IDs. Profile → ⋯ → Copy member ID.",
  discord: "Discord user IDs. Turn on Developer Mode, then right-click a person → Copy User ID.",
  telegram: "Telegram user IDs, numbers. The bot tells people theirs when it turns them away.",
} as const;

export function BotView(props: {
  api: Api;
  bot: BotStatus;
  status: Status;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  onChanged: () => void;
}) {
  const { api, bot } = props;
  const state = botState(bot, props.status.t3);
  const platform = PLATFORM_NAMES[bot.platform];
  const [toggling, setToggling] = useState(false);

  return (
    <div className="page">
      <TopNav crumbs={["Your bots", bot.name]} action="back" />
      <header className="bot-head">
        <div className="title-block">
          <div className="row wrap">
            <span className="pill platform solid">
              <PlatformBadge platform={bot.platform} size={22} round />
              {platform}
            </span>
            <span className={`pill state dark ${state.tone}`} title={state.detail}>
              <span className="dot" />
              {state.label}
            </span>
            <span className="handle">{botHandle(bot)}</span>
          </div>
          <h1 className="title">{bot.name}</h1>
        </div>
        <div className="head-actions">
          <span className="toggle-pill">
            Bot is {bot.enabled ? "on" : "off"}
            <Switch
              on={bot.enabled}
              label={bot.enabled ? "Turn the bot off" : "Turn the bot on"}
              onChange={(enabled) => {
                setToggling(true);
                void api
                  .updateBot(bot.id, { enabled })
                  .then(props.onChanged)
                  .catch((cause: unknown) => alert(errorText(cause)))
                  .finally(() => setToggling(false));
              }}
            />
            {toggling && <span className="sr-only">Saving</span>}
          </span>
          <a className="btn primary" href={openLink(bot)} target="_blank" rel="noreferrer">
            Open in {platform}
            <ArrowUpRight size={16} className="lime" />
          </a>
        </div>
      </header>

      {state.tone === "problem" && state.detail && <div className="banner">{state.detail}</div>}
      {bot.lastError && <div className="banner">{bot.lastError}</div>}

      <div className="bot-body">
        <BotSettings api={api} bot={bot} threads={props.threads} reloadThreads={props.reloadThreads} onSaved={props.onChanged} />
        <aside className="side">
          <div className="card stats">
            <div>
              <div className="num">{bot.activity.today}</div>
              <div className="eyebrow">Requests today</div>
            </div>
            <div className={bot.activity.problemsToday > 0 ? "bad" : ""}>
              <div className="num">{bot.activity.problemsToday}</div>
              <div className="eyebrow">Problems today</div>
            </div>
          </div>
          {bot.platform === "slack" ? (
            <SlackCard api={api} bot={bot} manifestVersion={props.status.manifestVersion} onSaved={props.onChanged} />
          ) : (
            <TokenCard api={api} bot={bot} onSaved={props.onChanged} />
          )}
          <button
            className="remove-card"
            onClick={() => {
              if (!confirm(`Remove ${bot.name}? The bot stays in ${platform}; T3 Bridge forgets its token.`)) return;
              void api
                .removeBot(bot.id)
                .then(() => {
                  props.onChanged();
                  go({ page: "home" });
                })
                .catch((cause: unknown) => alert(errorText(cause)));
            }}
          >
            <span className="remove-title">Remove this bot</span>
            <span>Stops the bot and removes it from T3 Bridge. The bot stays in {platform}.</span>
          </button>
        </aside>
      </div>
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
  const [instructions, setInstructions] = useState(bot.instructions);
  const [reminder, setReminder] = useState(bot.reminder);
  const [allowed, setAllowed] = useState<string[]>([...bot.allowedUserIds]);
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const thread = props.threads?.threads.find((candidate) => candidate.id === threadId);
  const dirty =
    name.trim() !== bot.name ||
    threadId !== bot.threadId ||
    instructions !== bot.instructions ||
    reminder !== bot.reminder ||
    allowed.join(",") !== bot.allowedUserIds.join(",");

  const save = async (sendInstructions: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.updateBot(bot.id, {
        name: name.trim() || bot.name,
        threadId,
        allowedUserIds: allowed,
        instructions,
        reminder,
        sendInstructions,
      });
      setMessage({ ok: true, text: sendInstructions ? "Saved and sent" : "Saved" });
      props.onSaved();
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  const freshThread = async () => {
    if (!confirm(`Start a fresh orchestrator thread for ${bot.name}? It gets the same project, model and instructions; the current thread stays in T3, unpinned.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const fresh = await api.newThread(bot.id);
      await props.reloadThreads();
      setThreadId(fresh.threadId);
      setMessage({ ok: true, text: `Now talking to ${fresh.title}` });
      props.onSaved();
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  const addPerson = () => {
    const ids = (adding ?? "").split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    setAllowed((current) => [...current, ...ids.filter((id) => !current.includes(id))]);
    setAdding(null);
  };

  return (
    <section className="card settings-card">
      <Section title="Name" desc={`Shown in the panel only. Rename the ${bot.platform === "slack" ? "app" : "bot"} in ${PLATFORM_NAMES[bot.platform]} to change it there.`}>
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </Section>

      <Section title="Orchestrator thread" desc={`Every message from ${PLATFORM_NAMES[bot.platform]} goes to this T3 thread.`}>
        {props.threads === null ? (
          <p className="muted">Loading threads from T3…</p>
        ) : (
          <SelectBox
            icon={<Pin size={16} />}
            title={threadId === null ? "Choose a thread" : (thread?.title ?? "Thread")}
            meta={threadMeta(thread)}
            value={threadId ?? ""}
            onChange={(value) => setThreadId(value || null)}
          >
            {threadId === null && <option value="">Choose a thread…</option>}
            <ThreadOptions threads={props.threads} />
          </SelectBox>
        )}
        <div className="links">
          <button className="link" disabled={busy || bot.threadId === null} onClick={() => void freshThread()}>
            <Plus size={14} />
            Start a fresh thread
          </button>
          <button className="link" disabled={busy || threadId === null} onClick={() => void save(true)}>
            <Send size={14} />
            {dirty ? "Save, then send the instructions to the thread" : "Send the instructions to the thread now"}
          </button>
        </div>
      </Section>

      <Section title="Who may use it" desc={USER_ID_HINT[bot.platform]}>
        <div className="people">
          {allowed.map((id, index) => (
            <span key={id} className="person">
              <span className="mono">{id}</span>
              {index === 0 && <span className="owner">OWNER</span>}
              <button aria-label={`Remove ${id}`} title="Remove" onClick={() => setAllowed(allowed.filter((other) => other !== id))}>
                <X size={13} />
              </button>
            </span>
          ))}
          {adding === null ? (
            <button className="btn outline sm" onClick={() => setAdding("")}>
              <Plus size={14} />
              Add person
            </button>
          ) : (
            <span className="add-person">
              <input
                className="input mono sm"
                autoFocus
                placeholder={bot.platform === "slack" ? "U012AB3CD" : "User ID"}
                value={adding}
                onChange={(event) => setAdding(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addPerson();
                  if (event.key === "Escape") setAdding(null);
                }}
              />
              <button className="btn primary sm" disabled={!adding.trim()} onClick={addPerson}>
                Add
              </button>
              <button className="btn outline sm" onClick={() => setAdding(null)}>
                Cancel
              </button>
            </span>
          )}
        </div>
        {allowed.length === 0 && <p className="muted small">Nobody yet. The first person to DM the bot becomes its owner.</p>}
      </Section>

      <Section title="Instructions" desc="A new thread starts with these." last>
        <textarea className="input" rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        <Checkbox checked={reminder} onChange={setReminder}>
          Add a one-line role reminder to every message, so a long thread never forgets it
        </Checkbox>
      </Section>

      <div className="save-row">
        {message ? (
          <span className={`eyebrow ${message.ok ? "ok-text" : "error-text"}`}>{message.text}</span>
        ) : (
          dirty && <span className="eyebrow">Unsaved changes</span>
        )}
        <button className="btn primary" disabled={busy || !dirty || threadId === null} onClick={() => void save(false)}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}

function Section({ title, desc, last = false, children }: { title: string; desc: string; last?: boolean; children: ReactNode }) {
  return (
    <div className={`section${last ? " last" : ""}`}>
      <div className="section-label">
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>
      <div className="section-control">{children}</div>
    </div>
  );
}

// ── platform cards ────────────────────────────────────────────────────────

function TokenRow({ label, prefix, bot }: { label: string; prefix: string; bot: BotStatus }) {
  const connected = bot.connection.state === "connected";
  return (
    <div className="kv">
      <span>{label}</span>
      <span className="kv-value">
        <span className="mono">{prefix}••••</span>
        {connected ? (
          <CircleCheck size={14} className="lime" aria-label="Working" />
        ) : bot.enabled ? (
          <CircleAlert size={14} className="error-soft" aria-label="Not connected" />
        ) : null}
      </span>
    </div>
  );
}

function SlackCard(props: { api: Api; bot: BotStatus; manifestVersion: number; onSaved: () => void }) {
  const { api, bot } = props;
  const manifest = useManifest(api, bot.name);
  const [replacing, setReplacing] = useState(false);
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
      setReplacing(false);
      setMessage({ ok: true, text: `Now @${result.botUser} in ${result.team}` });
      props.onSaved();
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dark-card platform-card">
      <div className="platform-head">
        <h2 className="dark-title">{PLATFORM_CARD.slack}</h2>
        {bot.manifestOutdated ? (
          <span className="badge warn">Needs an update</span>
        ) : (
          <span className="badge lime">
            <Check size={12} />
            Up to date
          </span>
        )}
      </div>
      {bot.manifestOutdated ? (
        <div className="update-steps">
          <p>
            The new version turns the bot into a Slack AI app: each request gets its own thread with streaming replies, "is
            working…", a Stop button and canvases for long reports.
          </p>
          <ol>
            <li>
              Open{" "}
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
                api.slack.com/apps
              </a>
              , pick {bot.name}, and open App Manifest.
            </li>
            <li>Replace everything with the new manifest and choose Save Changes.</li>
            <li>Choose Reinstall to Workspace and Allow. The tokens stay the same.</li>
          </ol>
          {manifest && <ManifestText text={manifest.text} />}
          <button className="btn lime" disabled={busy} onClick={() => void markUpdated()}>
            Done, I reinstalled it
          </button>
        </div>
      ) : null}
      <TokenRow label="Bot token" prefix="xoxb-" bot={bot} />
      <TokenRow label="App token" prefix="xapp-" bot={bot} />
      <p className="dark-note">
        To use it in a channel, invite it there with <code>/invite @{bot.name}</code>.
      </p>
      {replacing ? (
        <div className="replace">
          <p className="dark-note">Only needed if you regenerated them in Slack or moved the bot to another Slack app.</p>
          <input className="input dark mono" placeholder="Bot token, xoxb-…" value={botToken} onChange={(event) => setBotToken(event.target.value)} />
          <input className="input dark mono" placeholder="App-level token, xapp-…" value={appToken} onChange={(event) => setAppToken(event.target.value)} />
          <div className="row">
            <button
              className="btn lime"
              disabled={busy || !botToken.trim().startsWith("xoxb-") || !appToken.trim().startsWith("xapp-")}
              onClick={() => void replaceTokens()}
            >
              Check and save
            </button>
            <button className="btn ghost-dark" onClick={() => setReplacing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn ghost-dark full" onClick={() => setReplacing(true)}>
          Replace tokens
        </button>
      )}
      {message && <span className={message.ok ? "lime-text small" : "error-soft small"}>{message.text}</span>}
    </div>
  );
}

function TokenCard(props: { api: Api; bot: BotStatus; onSaved: () => void }) {
  const { api, bot } = props;
  const platform = bot.platform as "discord" | "telegram";
  const [replacing, setReplacing] = useState(false);
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
      setReplacing(false);
      setMessage({ ok: true, text: `Now ${result.botUser}` });
      props.onSaved();
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dark-card platform-card">
      <div className="platform-head">
        <h2 className="dark-title">{PLATFORM_CARD[platform]}</h2>
        {bot.connection.identity && <span className="badge lime">{bot.connection.identity.replace(/ on (Discord|Telegram)$/, "")}</span>}
      </div>
      <TokenRow label="Bot token" prefix="" bot={bot} />
      <p className="dark-note">
        {platform === "discord" ? (
          <>
            People can message the bot once it shares a server with them. In a channel, mention it (
            <code>@{bot.account?.username ?? bot.name}</code>) or reply to one of its messages.
          </>
        ) : (
          "Message the bot directly, or add it to a group and mention it or reply to its messages."
        )}
      </p>
      {bot.chatLink && (
        <a className="btn lime full" href={bot.chatLink} target="_blank" rel="noreferrer">
          {platform === "discord" ? "Add to a server" : "Open in Telegram"}
          <ArrowUpRight size={15} />
        </a>
      )}
      {replacing ? (
        <div className="replace">
          <p className="dark-note">
            {platform === "discord"
              ? "Only needed if you reset the token in the Discord developer portal."
              : "Only needed if you revoked the token with @BotFather."}
          </p>
          <input
            className="input dark mono"
            placeholder={platform === "discord" ? "Bot token" : "123456:ABC…"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <div className="row">
            <button className="btn lime" disabled={busy || token.trim().length < 20} onClick={() => void replaceToken()}>
              Check and save
            </button>
            <button className="btn ghost-dark" onClick={() => setReplacing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn ghost-dark full" onClick={() => setReplacing(true)}>
          Replace token
        </button>
      )}
      {message && <span className={message.ok ? "lime-text small" : "error-soft small"}>{message.text}</span>}
    </div>
  );
}
