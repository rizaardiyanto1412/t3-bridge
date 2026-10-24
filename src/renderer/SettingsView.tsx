import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { adoptToken, type Api, type LogEntry, type Status, type UpdateCheck, type UpdateStatus } from "./api.ts";
import { errorText, maskedLink, TopNav, useCopied, useQr } from "./shared.tsx";

export function SettingsView({ api, status }: { api: Api; status: Status }) {
  return (
    <div className="page">
      <TopNav crumbs={["Settings"]} action="back" />
      <h1 className="title">Settings</h1>
      <div className="settings-grid">
        <OtherDevices api={api} status={status} />
        <div className="side">
          <ThisMac status={status} />
          <Updates api={api} version={status.version} />
        </div>
        <RawLog api={api} />
        <Terminal />
      </div>
    </div>
  );
}

function OtherDevices({ api, status }: { api: Api; status: Status }) {
  const link = status.connectLinks[0];
  const qr = useQr(link);
  const [copied, copy] = useCopied();
  return (
    <section className="dark-card devices">
      <div className="qr-box">{qr ? <img src={qr} alt="QR code of the panel link" /> : <span className="muted small">No link</span>}</div>
      <div className="devices-copy">
        <h2 className="dark-title big">Open from other devices</h2>
        {link === undefined ? (
          <p>
            This Mac has no Tailscale address, so only this Mac can open the panel. Install Tailscale, then run{" "}
            <code>npx t3-bridge link</code>.
          </p>
        ) : (
          <>
            <p>
              Scan with your phone's camera, or copy the link. Anyone with it can control your bots, so treat it like a
              password.
            </p>
            <div className="link-row">
              <span className="mono">{maskedLink(link)}</span>
              <button className="btn lime sm" onClick={() => copy(link)}>
                <Copy size={14} />
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <button
              className="link light"
              onClick={async () => {
                if (!confirm("Replace the link? Every copy of the old link stops working, including bookmarks on other devices.")) return;
                const result = await api.rotateLink();
                adoptToken(result.token);
              }}
            >
              <RefreshCw size={14} />
              Replace link
              <span className="faint-light">· every old copy stops working</span>
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function ThisMac({ status }: { status: Status }) {
  const t3 = status.t3;
  const link = status.connectLinks[0];
  const address = link ? new URL(link).hostname : null;
  return (
    <section className="card small-card">
      <h2 className="small-title">This Mac</h2>
      <div className="kv">
        <span>Computer</span>
        <b>{t3.label || location.hostname}</b>
      </div>
      <div className="kv" title={t3.error}>
        <span>T3 Code</span>
        <b className="row">
          <span className={`dot ${t3.state === "connected" ? "ok" : t3.state === "connecting" ? "pending" : "bad"}`} />
          {t3.state === "connected" ? "Connected" : t3.state === "connecting" ? "Connecting…" : "Not connected"}
        </b>
      </div>
      <div className="kv">
        <span>Tailscale</span>
        {address ? <b className="mono">{address}</b> : <b className="muted">Not set up</b>}
      </div>
    </section>
  );
}

/** Installs the newest version from npm and restarts the background service, without a terminal. */
function Updates({ api, version }: { api: Api; version: string }) {
  const [info, setInfo] = useState<{ supported: boolean; current: string } | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<UpdateStatus | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setCheck(await api.checkUpdate());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void api.updateInfo().then((result) => {
      setInfo(result);
      const status = result.status;
      if (status && (status.state === "running" || status.state === "restarting")) {
        setStartedAt(Date.parse(status.startedAt));
        setProgress(status);
      } else if (status?.state === "failed") {
        setProgress(status);
      }
      if (result.supported) void runCheck();
    });
  }, [api]);

  // While updating, T3 Bridge restarts and briefly stops answering; keep asking until the
  // new version reports the update finished, then reload to get its panel.
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

  const update = async () => {
    setError(null);
    try {
      setStartedAt(Date.now());
      setProgress({ state: "running", step: "Starting", from: "", to: null, error: null, startedAt: new Date().toISOString(), finishedAt: null });
      await api.startUpdate();
    } catch (cause) {
      setStartedAt(null);
      setProgress(null);
      setError(errorText(cause));
    }
  };

  const updating = startedAt !== null;
  const current = info?.current ?? version;
  return (
    <section className="card small-card">
      <div className="kv">
        <h2 className="small-title">Updates</h2>
        {check?.available ? (
          <span className="badge warn">v{check.latest} available</span>
        ) : (
          <span className="badge dark">
            {check && <Check size={12} />}v{current}
            {check ? " · latest" : ""}
          </span>
        )}
      </div>
      {info !== null && !info.supported ? (
        <p className="small-text">
          This copy of T3 Bridge wasn't installed as a background service, so update it from a terminal with{" "}
          <code>npx t3-bridge@latest install</code>.
        </p>
      ) : updating && progress ? (
        <p className="small-text row">
          <span className="dot working" /> {progress.step}… The bots pause for a moment while T3 Bridge restarts.
        </p>
      ) : (
        <>
          <p className="small-text">
            The bots pause for a moment while T3 Bridge restarts.
            {check?.available && (
              <>
                {" "}
                <a href="https://github.com/rizaardiyanto1412/t3-bridge/releases" target="_blank" rel="noreferrer">
                  What's new
                </a>
              </>
            )}
          </p>
          <div>
            {check?.available ? (
              <button className="btn primary" onClick={() => void update()}>
                Update to {check.latest}
              </button>
            ) : (
              <button className="btn outline" disabled={checking || info === null} onClick={() => void runCheck()}>
                <RefreshCw size={14} className={checking ? "spin" : ""} />
                {checking ? "Checking…" : "Check now"}
              </button>
            )}
          </div>
        </>
      )}
      {!updating && progress?.state === "failed" && <p className="error-text small">The last update failed: {progress.error}</p>}
      {error && <p className="error-text small">{error}</p>}
    </section>
  );
}

const LEVEL_LABEL = { info: "INFO", warn: "WARN", error: "ERROR" } as const;

function RawLog({ api }: { api: Api }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  useEffect(() => {
    const load = () => void api.logs().then((result) => setEntries(result.entries)).catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [api]);
  return (
    <section className="card small-card log-card">
      <div className="kv">
        <h2 className="small-title">Log</h2>
        <span className="mono path">~/Library/Logs/T3 Bridge.log</span>
      </div>
      <div className="log">
        {entries === null
          ? "Loading…"
          : entries.length === 0
            ? "Nothing yet."
            : entries
                .slice()
                .reverse()
                .map((entry, index) => (
                  <div key={index} className="log-line">
                    <span className="faint">{new Date(entry.at).toTimeString().slice(0, 8)}</span>
                    <span className={`level ${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
                    <span>{entry.message}</span>
                  </div>
                ))}
      </div>
    </section>
  );
}

const COMMANDS = [
  ["npx t3-bridge link", "print the panel link"],
  ["npx t3-bridge status", "is everything connected"],
  ["npx t3-bridge uninstall", "stop it; bots and settings are kept"],
] as const;

function Terminal() {
  return (
    <section className="card small-card">
      <h2 className="small-title">From the terminal</h2>
      {COMMANDS.map(([command, what]) => (
        <div key={command} className="command">
          <span className="mono">$ {command}</span>
          <span>{what}</span>
        </div>
      ))}
    </section>
  );
}
