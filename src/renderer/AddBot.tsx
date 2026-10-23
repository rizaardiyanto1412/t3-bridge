import { useEffect, useState } from "react";

import { PLATFORM_NAMES, type Api, type Platform, type Status } from "./api.ts";
import {
  errorText,
  go,
  ManifestText,
  PlatformIcon,
  slackCreateUrl,
  ThreadPicker,
  useManifest,
  type Threads,
} from "./shared.tsx";

const STEPS = ["Create bot", "Connect", "Thread", "Say hello"];

/** A token pasted so far looks complete enough to check. */
function tokenReady(platform: Platform, botToken: string, appToken: string) {
  if (platform === "slack") return botToken.startsWith("xoxb-") && appToken.startsWith("xapp-");
  if (platform === "telegram") return /^\d+:[\w-]{30,}$/.test(botToken);
  return botToken.length >= 50 && !/\s/.test(botToken);
}

export function AddBot(props: {
  api: Api;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  status: Status;
  onCreated: (id: string) => void;
}) {
  const { api } = props;
  const [step, setStep] = useState(0);
  const [platform, setPlatform] = useState<Platform>("slack");
  const [name, setName] = useState("");
  const [opened, setOpened] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [check, setCheck] = useState<{
    state: "idle" | "checking" | "ok" | "bad";
    text: string;
    link?: string;
    note?: string;
  }>({ state: "idle", text: "" });
  const [threadId, setThreadId] = useState<string | null>(null);
  const [createdThread, setCreatedThread] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [sendInstructions, setSendInstructions] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(null);
  const manifest = useManifest(api, name.trim());

  useEffect(() => {
    void api.defaults().then((defaults) => setInstructions(defaults.instructions));
  }, [api]);

  // Tokens are checked as soon as they look complete, so a wrong paste shows at once.
  useEffect(() => {
    const tokens = { botToken: botToken.trim(), appToken: appToken.trim() };
    if (!tokenReady(platform, tokens.botToken, tokens.appToken)) {
      setCheck({ state: "idle", text: "" });
      return;
    }
    setCheck({ state: "checking", text: "Checking…" });
    let current = true;
    const test = async (): Promise<typeof check> => {
      if (platform === "slack") {
        const result = await api.testSlack(tokens);
        return { state: "ok", text: `✓ ${result.botUser} in ${result.team}` };
      }
      if (platform === "discord") {
        const result = await api.testDiscord({ botToken: tokens.botToken });
        return {
          state: "ok",
          text: `✓ ${result.botUser}`,
          link: result.inviteUrl,
          ...(result.messageContent
            ? {}
            : {
                note: "Optional: turn on Message Content Intent under Bot so the bot also reads replies that don't mention it.",
              }),
        };
      }
      const result = await api.testTelegram({ botToken: tokens.botToken });
      return { state: "ok", text: `✓ @${result.botUser}`, link: result.link };
    };
    const timer = setTimeout(() => {
      test()
        .then((result) => current && setCheck(result))
        .catch((cause: unknown) => current && setCheck({ state: "bad", text: errorText(cause) }));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, platform, botToken, appToken]);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const bot = await api.addBot({
        name: name.trim() || "T3 Bot",
        platform,
        ...(platform === "slack"
          ? { slack: { botToken: botToken.trim(), appToken: appToken.trim() } }
          : { [platform]: { botToken: botToken.trim() } }),
        threadId,
        instructions,
        reminder: true,
        sendInstructions: sendInstructions && !createdThread,
      });
      setBotId(bot.id);
      setStep(3);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const created = botId === null ? undefined : props.status.bots.find((bot) => bot.id === botId);
  const claimed = created !== undefined && (created.allowedUserIds.length > 0 || created.activity.today > 0);

  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost icon back" onClick={() => go({ page: "home" })} aria-label="Back">
          ←
        </button>
        <div className="grow">
          <h1>Add a {PLATFORM_NAMES[platform]} bot</h1>
          <div className="subtitle">One {PLATFORM_NAMES[platform]} bot talking to one T3 thread. About two minutes.</div>
        </div>
        {botId === null && (
          <button className="btn ghost" onClick={() => go({ page: "home" })}>
            Cancel
          </button>
        )}
      </div>
      <div className="stepper">
        {STEPS.map((label, index) => (
          <div key={label} className={index < step ? "done" : index === step ? "current" : ""}>
            {index + 1} · {label}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="card stack">
          <div className="segmented">
            {(["slack", "discord", "telegram"] as const).map((choice) => (
              <button
                key={choice}
                className={platform === choice ? "active" : ""}
                onClick={() => {
                  setPlatform(choice);
                  setCheck({ state: "idle", text: "" });
                }}
              >
                <span className="row" style={{ gap: 6 }}>
                  <PlatformIcon platform={choice} />
                  {PLATFORM_NAMES[choice]}
                </span>
              </button>
            ))}
          </div>
          <label className="field">
            <span>
              Bot name{" "}
              <span className="hint">
                · {platform === "slack" ? "how it appears in Slack" : "how it appears in T3 Bridge"}
              </span>
            </span>
            <input className="input" placeholder="e.g. WP Keeper" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          {platform === "slack" && (
            <div className="stack tight">
              <div>
                <a
                  className={`btn primary${name.trim() && manifest ? "" : " disabled"}`}
                  href={manifest && name.trim() ? slackCreateUrl(manifest.json) : undefined}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpened(true)}
                  style={name.trim() && manifest ? { textDecoration: "none" } : { opacity: 0.5, pointerEvents: "none" }}
                >
                  Create Slack app ↗
                </a>
              </div>
              <ol className="steps-list muted small">
                <li>Slack opens with the app already filled in. Pick your workspace and choose <b>Next</b>, then <b>Create</b>.</li>
                <li>
                  Under <b>Install App</b>, choose <b>Install to Workspace</b> and <b>Allow</b>.
                </li>
              </ol>
              {manifest && name.trim() && <ManifestText text={manifest.text} />}
            </div>
          )}
          {platform === "discord" && (
            <div className="stack tight">
              <div>
                <a
                  className="btn primary"
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpened(true)}
                  style={{ textDecoration: "none" }}
                >
                  Open the Discord developer portal ↗
                </a>
              </div>
              <ol className="steps-list muted small">
                <li>
                  Choose <b>New Application</b>, name it{name.trim() ? <> <b>{name.trim()}</b></> : ""}, and create it.
                </li>
                <li>
                  Open <b>Bot</b> and choose <b>Reset Token</b>. Copy the token; you paste it in the next step.
                </li>
                <li>
                  Optional, on the same page: turn on <b>Message Content Intent</b>, so the bot also reads replies
                  that don't mention it.
                </li>
              </ol>
            </div>
          )}
          {platform === "telegram" && (
            <div className="stack tight">
              <div>
                <a
                  className="btn primary"
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpened(true)}
                  style={{ textDecoration: "none" }}
                >
                  Open @BotFather ↗
                </a>
              </div>
              <ol className="steps-list muted small">
                <li>
                  Send <code>/newbot</code>, then a display name{name.trim() ? <> such as <b>{name.trim()}</b></> : ""}, then
                  a username ending in <code>bot</code>.
                </li>
                <li>BotFather replies with a token like <code>123456:ABC…</code>. Copy it; you paste it in the next step.</li>
              </ol>
            </div>
          )}
          <div className="wizard-foot">
            <span />
            <button className="btn primary" disabled={!name.trim()} onClick={() => setStep(1)}>
              {opened ? "Next" : "I created it, next"}
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card stack">
          {platform === "slack" ? (
            <>
              <label className="field">
                <span>
                  Bot token <span className="hint">· Install App → Bot User OAuth Token</span>
                </span>
                <input className="input mono" placeholder="xoxb-…" value={botToken} onChange={(event) => setBotToken(event.target.value)} autoFocus />
              </label>
              <label className="field">
                <span>
                  App-level token{" "}
                  <span className="hint">
                    · Basic Information → App-Level Tokens → Generate Token and Scopes, with the{" "}
                    <code>connections:write</code> scope
                  </span>
                </span>
                <input className="input mono" placeholder="xapp-…" value={appToken} onChange={(event) => setAppToken(event.target.value)} />
              </label>
            </>
          ) : (
            <label className="field">
              <span>
                Bot token{" "}
                <span className="hint">
                  {platform === "discord" ? "· Bot → Reset Token" : "· the token @BotFather sent you"}
                </span>
              </span>
              <input
                className="input mono"
                placeholder={platform === "discord" ? "Paste the bot token" : "123456:ABC…"}
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                autoFocus
              />
            </label>
          )}
          {check.state !== "idle" && (
            <span className={check.state === "ok" ? "ok-text small" : check.state === "bad" ? "error-text small" : "muted small"}>
              {check.text}
            </span>
          )}
          {check.state === "ok" && platform === "discord" && check.link && (
            <div className="stack tight">
              <p className="small" style={{ margin: 0 }}>
                Add the bot to a server you are in. Discord only lets people message a bot they share a server with.
              </p>
              <div>
                <a className="btn" href={check.link} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                  Add to a server ↗
                </a>
              </div>
            </div>
          )}
          {check.state === "ok" && check.note && <span className="muted small">{check.note}</span>}
          <div className="wizard-foot">
            <button className="btn" onClick={() => setStep(0)}>
              Back
            </button>
            <button className="btn primary" disabled={check.state !== "ok"} onClick={() => setStep(2)}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card stack">
          <p className="muted small" style={{ margin: 0 }}>
            The bot talks to one T3 thread. That thread acts as the orchestrator: it hands each task
            to a subagent and reports back.
          </p>
          <ThreadPicker
            api={api}
            threads={props.threads}
            value={threadId}
            instructions={instructions}
            onChange={(id, isNew) => {
              setThreadId(id);
              setCreatedThread(isNew);
            }}
            reload={props.reloadThreads}
          />
          {threadId !== null && !createdThread && (
            <label className="check">
              <input type="checkbox" checked={sendInstructions} onChange={(event) => setSendInstructions(event.target.checked)} />
              <span>Send the orchestrator instructions to this thread</span>
            </label>
          )}
          <details>
            <summary className="small muted">Orchestrator instructions</summary>
            <textarea
              className="input mono"
              style={{ marginTop: 8 }}
              rows={8}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </details>
          {error && <div className="banner bad">{error}</div>}
          <div className="wizard-foot">
            <button className="btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn primary" disabled={threadId === null || saving} onClick={() => void add()}>
              {saving ? "Adding…" : "Add bot"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card stack">
          {claimed ? (
            <>
              <h2 className="ok-text">✓ {name.trim()} is ready</h2>
              <p className="muted" style={{ margin: 0 }}>
                It's yours: only you can send it work. Add teammates under Settings → Who may use it.
              </p>
            </>
          ) : (
            <>
              <h2>Say hello</h2>
              <p style={{ margin: 0 }}>
                {platform === "slack" && (
                  <>
                    In Slack, open <b>{name.trim()}</b> (under <b>Apps</b>) and send it a message.
                  </>
                )}
                {platform === "discord" && (
                  <>
                    In Discord, open the bot's profile in the server you added it to and choose{" "}
                    <b>Message</b>, then send it a message.
                  </>
                )}
                {platform === "telegram" && (
                  <>
                    Open{" "}
                    {created?.chatLink ? (
                      <a href={created.chatLink} target="_blank" rel="noreferrer">
                        the bot in Telegram
                      </a>
                    ) : (
                      "the bot in Telegram"
                    )}{" "}
                    and press <b>Start</b>.
                  </>
                )}{" "}
                The first person to message it becomes its owner, so do it before anyone else.
              </p>
              <p className="row muted small" style={{ margin: 0 }}>
                <span className="dot working" /> Waiting for your first message…
              </p>
            </>
          )}
          <div className="wizard-foot">
            <span />
            <button className={`btn${claimed ? " primary" : ""}`} onClick={() => botId && props.onCreated(botId)}>
              {claimed ? "Open conversation" : "Skip"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
