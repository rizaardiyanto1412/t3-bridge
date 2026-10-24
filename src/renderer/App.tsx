import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/ibm-plex-mono/400.css";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AddBot } from "./AddBot.tsx";
import { makeApi, pageTarget, type Api, type Platform, type Status } from "./api.ts";
import { BotView } from "./BotView.tsx";
import { Home } from "./Home.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { errorText, go, PLATFORMS, TopNav, type Route, type Threads } from "./shared.tsx";

function readRoute(): Route {
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (page === "bot" && id) return { page: "bot", id };
  if (page === "add")
    return { page: "add", platform: PLATFORMS.includes(id as Platform) ? (id as Platform) : "slack" };
  if (page === "settings") return { page: "settings" };
  return { page: "home" };
}

export function App() {
  const [target] = useState(pageTarget);
  const api = useMemo(() => (target ? makeApi(target) : null), [target]);
  if (api === null) {
    return (
      <Notice title="Open this page with its link">
        On the Mac running T3 Bridge, run <code>npx t3-bridge link</code> and open the link it prints.
        It looks like <code>http://100.x.y.z:47821/#token=…</code>
      </Notice>
    );
  }
  return <Shell api={api} />;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page">
      <TopNav crumbs={[]} />
      <h1 className="title">{title}</h1>
      <div className="card notice">{children}</div>
    </div>
  );
}

function Shell({ api }: { api: Api }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Threads | null>(null);
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHash = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
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
      // The header already says when T3 is unreachable.
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    void refreshThreads();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh, refreshThreads]);

  if (status === null) {
    return error ? (
      <Notice title="Can't reach T3 Bridge">
        <p className="error-text">{error}</p>
        <p className="muted">
          Check that the Mac running it is on, and that this device is on the same Tailscale network.
        </p>
      </Notice>
    ) : (
      <div className="page">
        <TopNav crumbs={[]} />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const reloadAll = () => {
    void refresh();
    void refreshThreads();
  };
  const bot = route.page === "bot" ? status.bots.find((candidate) => candidate.id === route.id) : undefined;

  return (
    <>
      {error && <div className="lost">Lost contact with T3 Bridge: {error}</div>}
      {route.page === "home" && (
        <Home api={api} status={status} threads={threads} reloadThreads={refreshThreads} onChanged={reloadAll} />
      )}
      {route.page === "add" && (
        <AddBot
          key={route.platform}
          api={api}
          platform={route.platform}
          threads={threads}
          reloadThreads={refreshThreads}
          status={status}
          onCreated={reloadAll}
        />
      )}
      {route.page === "settings" && <SettingsView api={api} status={status} />}
      {route.page === "bot" && bot !== undefined && (
        <BotView
          key={bot.id}
          api={api}
          bot={bot}
          status={status}
          threads={threads}
          reloadThreads={refreshThreads}
          onChanged={reloadAll}
        />
      )}
      {route.page === "bot" && bot === undefined && (
        <Notice title="This bot was removed">
          <button className="btn primary" onClick={() => go({ page: "home" })}>
            Back to my bots
          </button>
        </Notice>
      )}
    </>
  );
}
