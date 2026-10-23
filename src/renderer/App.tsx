import { useCallback, useEffect, useMemo, useState } from "react";

import { AddBot } from "./AddBot.tsx";
import { makeApi, pageTarget, type Api, type BotStatus, type Status } from "./api.ts";
import { BotView } from "./BotView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import {
  ago,
  botHealth,
  BridgeMark,
  errorText,
  go,
  PlatformIcon,
  type Route,
  type Threads,
} from "./shared.tsx";

function readRoute(): Route {
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (page === "bot" && id) return { page: "bot", id };
  if (page === "add") return { page: "add" };
  if (page === "settings") return { page: "settings" };
  return { page: "home" };
}

export function App() {
  const [target] = useState(pageTarget);
  const api = useMemo(() => (target ? makeApi(target) : null), [target]);
  if (api === null) {
    return (
      <div className="connect card">
        <h1>Open this page with its link</h1>
        <p className="muted">
          On the Mac running T3 Bridge, run <code>npx t3-bridge link</code> and open the link it
          prints. It looks like <code>http://100.x.y.z:47821/#token=…</code>
        </p>
      </div>
    );
  }
  return <Shell api={api} />;
}

function Shell({ api }: { api: Api }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Threads | null>(null);
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [api]);

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await api.threads());
    } catch {
      // The sidebar already says when T3 is unreachable.
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    void refreshThreads();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh, refreshThreads]);

  // On a wide screen the first bot opens right away instead of an empty pane.
  useEffect(() => {
    if (route.page === "home" && status !== null && status.bots.length > 0 && window.innerWidth > 720) {
      go({ page: "bot", id: status.bots[0]!.id });
    }
  }, [route.page, status]);

  if (status === null) {
    return (
      <div className="connect card">
        {error ? (
          <>
            <h1>Can't reach T3 Bridge</h1>
            <p className="error-text">{error}</p>
            <p className="muted small">
              Check that the Mac running it is on, and that this device is on the same Tailscale
              network.
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    );
  }

  const bot = route.page === "bot" ? status.bots.find((candidate) => candidate.id === route.id) : undefined;
  const reloadAll = () => {
    void refresh();
    void refreshThreads();
  };

  return (
    <div className={`shell${route.page === "home" ? "" : " detail"}`}>
      <Sidebar status={status} route={route} lostContact={error} />
      <main className="main">
        {route.page === "add" && (
          <AddBot
            api={api}
            threads={threads}
            reloadThreads={refreshThreads}
            status={status}
            onCreated={(id) => {
              reloadAll();
              go({ page: "bot", id });
            }}
          />
        )}
        {route.page === "settings" && <SettingsView api={api} status={status} />}
        {route.page === "bot" && bot !== undefined && (
          <BotView
            key={bot.id}
            api={api}
            bot={bot}
            manifestVersion={status.manifestVersion}
            threads={threads}
            reloadThreads={refreshThreads}
            onChanged={reloadAll}
          />
        )}
        {route.page === "bot" && bot === undefined && (
          <div className="page empty">This bot was removed.</div>
        )}
        {route.page === "home" && status.bots.length === 0 && (
          <div className="page empty">
            <h1>Connect T3 to Slack</h1>
            <p>
              A bot is one Slack app talking to one T3 thread. That thread is the orchestrator: it
              hands the real work to subagents and reports back in Slack.
            </p>
            <button className="btn primary" onClick={() => go({ page: "add" })}>
              Add your first bot
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function Sidebar({ status, route, lostContact }: { status: Status; route: Route; lostContact: string | null }) {
  const t3 = status.t3;
  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <BridgeMark />
          T3 Bridge
        </div>
        <button className="btn primary sm" onClick={() => go({ page: "add" })}>
          + Add
        </button>
      </div>
      <div className="sidebar-list">
        {status.bots.length === 0 ? (
          <div className="empty-list">No bots yet. Add one to chat with a T3 thread from Slack.</div>
        ) : (
          <>
            <div className="group">
              <PlatformIcon />
              Slack
            </div>
            {status.bots.map((bot) => (
              <BotItem key={bot.id} bot={bot} selected={route.page === "bot" && route.id === bot.id} />
            ))}
          </>
        )}
      </div>
      <div className="sidebar-foot">
        <div className="foot-line" title={t3.error}>
          <span className={`dot ${lostContact ? "bad" : t3.state === "connected" ? "ok" : t3.state === "connecting" ? "pending" : "bad"}`} />
          {lostContact
            ? "Lost contact with T3 Bridge"
            : t3.state === "connected"
              ? `T3 Code · ${t3.label}`
              : t3.state === "connecting"
                ? "Connecting to T3 Code…"
                : "T3 Code not connected"}
        </div>
        <button
          className={`item${route.page === "settings" ? " selected" : ""}`}
          style={{ gridTemplateColumns: "1fr auto" }}
          onClick={() => go({ page: "settings" })}
        >
          <span className="item-name">Settings</span>
          <span className="item-side">v{status.version}</span>
        </button>
      </div>
    </nav>
  );
}

function BotItem({ bot, selected }: { bot: BotStatus; selected: boolean }) {
  const health = botHealth(bot);
  const working = bot.activity.working;
  const running = working?.subagents.filter((task) => task.status === "running" || task.status === "waiting").length ?? 0;
  let sub: { text: string; tone: "" | "working" | "problem" };
  if (health === "off") sub = { text: "Turned off", tone: "" };
  else if (health === "bad") sub = { text: bot.connection.error ?? "Not connected", tone: "problem" };
  else if (bot.threadId === null) sub = { text: "No thread picked", tone: "problem" };
  else if (working !== null)
    sub = { text: `${working.waiting ? "Waiting for you" : "Working"} · ${working.text}`, tone: "working" };
  else if (bot.manifestOutdated) sub = { text: "Slack app needs an update", tone: "problem" };
  else sub = { text: `Idle · ${bot.activity.today} today`, tone: "" };
  return (
    <button className={`item${selected ? " selected" : ""}`} onClick={() => go({ page: "bot", id: bot.id })}>
      <span className="item-name">
        <span className={`dot ${working !== null && health === "ok" ? "working" : health}`} />
        <span>{bot.name}</span>
      </span>
      <span className="item-side">
        {running > 0 ? <span className="badge">{running}</span> : ago(bot.activity.lastAt)}
      </span>
      <span className={`item-sub ${sub.tone}`}>{sub.text}</span>
    </button>
  );
}
