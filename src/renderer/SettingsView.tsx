import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { adoptToken, type Api, type LogEntry, type Status, type UpdateCheck, type UpdateStatus } from "./api.ts";
import { copyText, errorText, go } from "./shared.tsx";

export function SettingsView({ api, status }: { api: Api; status: Status }) {
  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost icon back" onClick={() => go({ page: "home" })} aria-label="Back">
          ←
        </button>
        <div className="grow">
          <h1>Settings</h1>
          <div className="subtitle">T3 Bridge on {status.t3.label || "this Mac"}</div>
        </div>
      </div>
      <div className="stack" style={{ marginTop: 16 }}>
        <OtherDevices api={api} status={status} />
        <Updates api={api} />
        <div className="card">
          <h2>This Mac</h2>
          <p className="muted small">
            T3 Bridge runs in the background and starts at login. From a terminal on this Mac:
          </p>
          <div className="small" style={{ display: "grid", gap: 4 }}>
            <span>
              <code>npx t3-bridge status</code> <span className="muted">· is everything connected</span>
            </span>
            <span>
              <code>npx t3-bridge link</code> <span className="muted">· print the panel link</span>
            </span>
            <span>
              <code>npx t3-bridge uninstall</code> <span className="muted">· stop it; bots and settings are kept</span>
            </span>
            <span className="muted">
              Logs: <code>~/Library/Logs/T3 Bridge.log</code>
            </span>
          </div>
        </div>
        <RawLog api={api} />
      </div>
    </div>
  );
}

function OtherDevices({ api, status }: { api: Api; status: Status }) {
  const link = status.connectLinks[0];
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (link === undefined) return;
    void QRCode.toDataURL(link, { margin: 0, width: 192 }).then(setQr);
  }, [link]);
  return (
    <div className="card">
      <h2>Open from other devices</h2>
      {link === undefined ? (
        <p className="muted small">
          This Mac has no Tailscale address, so only this Mac can open the panel. Install
          Tailscale, then run <code>npx t3-bridge link</code>.
        </p>
      ) : (
        <>
          <p className="muted small">
            Any device on your Tailscale network. Bookmark the link; it works like a password.
          </p>
          <div className="link-row">
            {qr && <img className="qr" src={qr} alt="QR code of the panel link" />}
            <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
              <span className="small muted">Scan with your phone's camera, or:</span>
              <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {link.replace(/token=.*/, "token=••••••")}
              </code>
              <div className="row wrap">
                <button
                  className="btn sm"
                  onClick={() => {
                    copyText(link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button
                  className="btn sm ghost"
                  onClick={async () => {
                    if (!confirm("Replace the link? Every copy of the old link stops working, including bookmarks on other devices.")) return;
                    const result = await api.rotateLink();
                    adoptToken(result.token);
                  }}
                >
                  Replace link
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
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
    });
    void runCheck();
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

  if (info === null || !info.supported) return null;

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
  return (
    <div className="card">
      <div className="row spread wrap">
        <div>
          <h2>Updates</h2>
          <p className="muted small" style={{ margin: "3px 0 0" }}>
            T3 Bridge {info.current}
            {!updating && check && !check.available && " · you're on the latest version"}
          </p>
        </div>
        {!updating && check?.available ? (
          <button className="btn primary" onClick={() => void update()}>
            Update to {check.latest}
          </button>
        ) : (
          !updating && (
            <button className="btn sm" disabled={checking} onClick={() => void runCheck()}>
              {checking ? "Checking…" : "Check now"}
            </button>
          )
        )}
      </div>
      {!updating && check?.available && (
        <p className="small" style={{ marginBottom: 0 }}>
          <a href="https://github.com/rizaardiyanto1412/t3-bridge/releases" target="_blank" rel="noreferrer">
            What's new
          </a>
        </p>
      )}
      {updating && progress && (
        <p className="row small" style={{ marginBottom: 0 }}>
          <span className="dot working" /> {progress.step}…{" "}
          <span className="muted">The bots pause for a moment while T3 Bridge restarts.</span>
        </p>
      )}
      {!updating && progress?.state === "failed" && (
        <p className="error-text small" style={{ marginBottom: 0 }}>
          The last update failed: {progress.error}
        </p>
      )}
      {error && <p className="error-text small" style={{ marginBottom: 0 }}>{error}</p>}
    </div>
  );
}

function RawLog({ api }: { api: Api }) {
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
    <div className="card">
      <div className="row spread">
        <div>
          <h2>Log</h2>
          <p className="muted small" style={{ margin: "3px 0 0" }}>
            What T3 Bridge did, line by line. Useful when something doesn't arrive.
          </p>
        </div>
        <button className="btn sm" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <pre className="log">
          {entries.length === 0
            ? "Nothing yet."
            : entries
                .slice()
                .reverse()
                .map((entry) => `${entry.at.slice(11, 19)} ${entry.level === "info" ? " " : entry.level === "warn" ? "!" : "✗"} ${entry.message}`)
                .join("\n")}
        </pre>
      )}
    </div>
  );
}
