import { useEffect, useState } from "react";

import type { Api, Status } from "./api.ts";
import {
  errorText,
  go,
  ManifestText,
  slackCreateUrl,
  ThreadPicker,
  useManifest,
  type Threads,
} from "./shared.tsx";

const STEPS = ["Create app", "Connect", "Thread", "Say hello"];

export function AddBot(props: {
  api: Api;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  status: Status;
  onCreated: (id: string) => void;
}) {
  const { api } = props;
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [opened, setOpened] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "bad"; text: string }>({ state: "idle", text: "" });
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

  // Tokens are checked as soon as both look complete, so a wrong paste shows at once.
  useEffect(() => {
    const slack = { botToken: botToken.trim(), appToken: appToken.trim() };
    if (!slack.botToken.startsWith("xoxb-") || !slack.appToken.startsWith("xapp-")) {
      setCheck({ state: "idle", text: "" });
      return;
    }
    setCheck({ state: "checking", text: "Checking…" });
    let current = true;
    const timer = setTimeout(() => {
      api
        .testSlack(slack)
        .then((result) => current && setCheck({ state: "ok", text: `✓ ${result.botUser} in ${result.team}` }))
        .catch((cause: unknown) => current && setCheck({ state: "bad", text: errorText(cause) }));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, botToken, appToken]);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const bot = await api.addBot({
        name: name.trim() || "T3 Bot",
        platform: "slack",
        slack: { botToken: botToken.trim(), appToken: appToken.trim() },
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
          <h1>Add a Slack bot</h1>
          <div className="subtitle">One Slack app talking to one T3 thread. About two minutes.</div>
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
          <label className="field">
            <span>Bot name <span className="hint">· how it appears in Slack</span></span>
            <input className="input" placeholder="e.g. WP Keeper" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
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
          {check.state !== "idle" && (
            <span className={check.state === "ok" ? "ok-text small" : check.state === "bad" ? "error-text small" : "muted small"}>
              {check.text}
            </span>
          )}
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
                In Slack, open <b>{name.trim()}</b> (under <b>Apps</b>) and send it a message. The
                first person to message it becomes its owner, so do it before anyone else.
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
