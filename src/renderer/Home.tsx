import { ArrowRight, CornerDownRight, Plus, QrCode, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";

import { PLATFORM_NAMES, type ActivityEntry, type Api, type BotStatus, type Status } from "./api.ts";
import {
  BrandMark,
  botHandle,
  botState,
  errorText,
  go,
  maskedLink,
  PlatformBadge,
  PlatformGlyph,
  PLATFORMS,
  startOfToday,
  StatePill,
  Switch,
  threadMeta,
  useActivities,
  useCopied,
  useQr,
  type Threads,
} from "./shared.tsx";

export function Home(props: {
  api: Api;
  status: Status;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  onChanged: () => void;
}) {
  const { api, status } = props;
  const activities = useActivities(
    api,
    status.bots.map((bot) => bot.id),
  );
  const [showQr, setShowQr] = useState(false);
  const [adding, setAdding] = useState(false);

  return (
    <div className="page">
      <header className="home-head">
        <div className="title-block">
          <a className="brand" href="#">
            <BrandMark />
            <span className="crumbs">T3 Bridge{status.t3.label ? `  /  ${status.t3.label}` : ""}</span>
          </a>
          <h1 className="title">Your bots</h1>
        </div>
        <div className="head-actions">
          <Health status={status} />
          {status.connectLinks.length > 0 && (
            <button className="icon-btn" aria-label="Open on your phone" title="Open on your phone" onClick={() => setShowQr(true)}>
              <QrCode size={17} />
            </button>
          )}
          <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => go({ page: "settings" })}>
            <Settings size={17} />
          </button>
          <div className="menu" onClick={(event) => event.stopPropagation()}>
            <button className="btn primary" onClick={() => setAdding(!adding)}>
              <Plus size={16} className="lime" />
              Add bot
            </button>
            {adding && <AddMenu onClose={() => setAdding(false)} />}
          </div>
        </div>
      </header>

      <TodayBand status={status} activities={activities} />

      <div className="deck">
        {status.bots.map((bot) => (
          <BotCard key={bot.id} api={api} bot={bot} status={status} threads={props.threads} reloadThreads={props.reloadThreads} onChanged={props.onChanged} />
        ))}
        <div className="add-card">
          <span className="plus-badge">
            <Plus size={24} />
          </span>
          <div className="add-copy">
            <h2 className="card-title">{status.bots.length === 0 ? "Add your first bot" : "Add a bot"}</h2>
            <p>
              Connect a Slack, Discord or Telegram bot to a T3 thread. Four steps, about two minutes.
            </p>
          </div>
          {PLATFORMS.map((platform) => (
            <button key={platform} className="platform-row" onClick={() => go({ page: "add", platform })}>
              <PlatformBadge platform={platform} size={30} />
              <span className="grow">{PLATFORM_NAMES[platform]}</span>
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
      </div>

      {showQr && <QrDialog link={status.connectLinks[0]!} onClose={() => setShowQr(false)} />}
    </div>
  );
}

function Health({ status }: { status: Status }) {
  const t3 = status.t3;
  const items = [
    {
      label: "T3 Code",
      tone: t3.state === "connected" ? "ok" : t3.state === "connecting" ? "pending" : "bad",
      title: t3.state === "connected" ? `Connected to ${t3.label}` : (t3.error ?? "Connecting…"),
    },
    {
      label: "Tailscale",
      tone: status.connectLinks.length > 0 ? "ok" : "off",
      title: status.connectLinks.length > 0 ? "Open the panel from any device on your tailnet" : "No Tailscale address: only this Mac can open the panel",
    },
    { label: `v${status.version}`, tone: "ok", title: "T3 Bridge version" },
  ];
  return (
    <div className="health">
      {items.map((item) => (
        <span key={item.label} title={item.title}>
          <span className={`dot ${item.tone}`} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function AddMenu({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    window.addEventListener("click", onClose);
    return () => window.removeEventListener("click", onClose);
  }, [onClose]);
  return (
    <div className="menu-list">
      {PLATFORMS.map((platform) => (
        <button key={platform} onClick={() => go({ page: "add", platform })}>
          <PlatformBadge platform={platform} size={24} />
          {PLATFORM_NAMES[platform]}
        </button>
      ))}
    </div>
  );
}

function QrDialog({ link, onClose }: { link: string; onClose: () => void }) {
  const qr = useQr(link);
  const [copied, copy] = useCopied();
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dark-card qr-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="qr-box">{qr && <img src={qr} alt="QR code of the panel link" />}</div>
        <h2 className="dark-title">Open on your phone</h2>
        <p>Scan with your phone's camera. Anyone with the link can control your bots, so treat it like a password.</p>
        <div className="link-row">
          <span className="mono">{maskedLink(link)}</span>
          <button className="btn lime sm" onClick={() => copy(link)}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── today ─────────────────────────────────────────────────────────────────

function TodayBand({ status, activities }: { status: Status; activities: Record<string, ActivityEntry[]> }) {
  const since = startOfToday();
  const today = Object.values(activities)
    .flat()
    .filter((entry) => Date.parse(entry.at) >= since);
  const hours = Array.from({ length: 24 }, () => 0);
  for (const entry of today) hours[new Date(entry.at).getHours()]! += 1;
  const peak = Math.max(1, ...hours);
  const now = new Date();
  const hour = now.getHours();
  const totals = [
    { value: status.bots.reduce((sum, bot) => sum + bot.activity.today, 0), label: "Requests today" },
    { value: today.reduce((sum, entry) => sum + entry.subagents.length, 0), label: "Subagents today" },
    { value: status.bots.reduce((sum, bot) => sum + bot.activity.problemsToday, 0), label: "Problems today" },
  ];
  // Fixed hour marks give way to the "now" mark when they would overlap it.
  const marks = [0, 6, 12, 18, 23].filter((mark) => Math.abs(mark - hour) > 2);

  return (
    <section className="today">
      <div className="totals">
        {totals.map((total) => (
          <div key={total.label} className={`total${total.label.startsWith("Problems") && total.value > 0 ? " bad" : ""}`}>
            <div className="num">{total.value}</div>
            <div className="eyebrow">{total.label}</div>
          </div>
        ))}
      </div>
      <div className="hourly">
        <div className="bars">
          {hours.map((count, index) => (
            <div
              key={index}
              title={`${String(index).padStart(2, "0")}:00 · ${count} request${count === 1 ? "" : "s"}`}
              className={`bar${index === hour ? " now" : count > 0 ? " some" : ""}`}
              style={{ height: count > 0 ? Math.max(8, Math.round((count / peak) * 56)) : 4 }}
            />
          ))}
        </div>
        <div className="axis">
          {marks.map((mark) => (
            <span key={mark} style={axisPosition(mark)}>
              {String(mark).padStart(2, "0")}
            </span>
          ))}
          <span className="now" style={axisPosition(hour)}>
            NOW {String(hour).padStart(2, "0")}:{String(now.getMinutes()).padStart(2, "0")}
          </span>
        </div>
      </div>
    </section>
  );
}

function axisPosition(hour: number) {
  if (hour === 0) return { left: 0 };
  if (hour === 23) return { right: 0 };
  return { left: `${((hour + 0.5) / 24) * 100}%`, transform: "translateX(-50%)" };
}

// ── bot card ──────────────────────────────────────────────────────────────

function BotCard(props: {
  api: Api;
  bot: BotStatus;
  status: Status;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  onChanged: () => void;
}) {
  const { api, bot } = props;
  const state = botState(bot, props.status.t3);
  const dark = bot.enabled && bot.activity.working !== null;
  const thread = props.threads?.threads.find((candidate) => candidate.id === bot.threadId);
  const [busy, setBusy] = useState(false);

  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    void run()
      .then(props.onChanged)
      .catch((cause: unknown) => alert(errorText(cause)))
      .finally(() => setBusy(false));
  };
  const open = () => go({ page: "bot", id: bot.id });

  return (
    <div className={`bot-card${dark ? " dark" : ""}`} onClick={open}>
      <div className="card-top">
        <div className="row">
          <span className="pill platform">
            <PlatformGlyph platform={bot.platform} size={13} />
            {PLATFORM_NAMES[bot.platform]}
          </span>
          <StatePill {...state} />
        </div>
        <Switch
          on={bot.enabled}
          label={bot.enabled ? `Turn ${bot.name} off` : `Turn ${bot.name} on`}
          onChange={(enabled) => act(() => api.updateBot(bot.id, { enabled }))}
        />
      </div>
      <div className="identity">
        <h2 className="card-title">{bot.name}</h2>
        <div className="handle">{botHandle(bot)}</div>
      </div>
      {state.tone === "problem" && state.detail && <div className="card-problem">{state.detail}</div>}
      <div className="spacer" />
      <div className="thread-line">
        <CornerDownRight size={16} className="faint" />
        <div className="grow">
          <div className="thread-title">{bot.threadId === null ? "No thread picked" : (thread?.title ?? "Thread")}</div>
          <div className="thread-meta">{threadMeta(thread)}</div>
        </div>
        <span className="thread-meta">{bot.activity.today} today</span>
      </div>
      <div className="card-actions" onClick={(event) => event.stopPropagation()}>
        {dark ? (
          <button className="btn lime" disabled={busy} onClick={() => act(() => api.stop(bot.id))}>
            Stop
          </button>
        ) : null}
        <button className="btn outline" onClick={open}>
          Settings
        </button>
        {!dark && (
          <button
            className="btn outline"
            disabled={busy || bot.threadId === null}
            onClick={() => {
              if (!confirm(`Start a fresh orchestrator thread for ${bot.name}? It gets the same project, model and instructions; the current thread stays in T3, unpinned.`)) return;
              act(async () => {
                await api.newThread(bot.id);
                await props.reloadThreads();
              });
            }}
          >
            New thread
          </button>
        )}
      </div>
    </div>
  );
}
