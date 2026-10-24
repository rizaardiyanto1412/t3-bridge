import { ArrowLeft, ChevronsUpDown, Gamepad2, Send, X, type LucideIcon } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState, type ReactNode } from "react";

import {
  PLATFORM_NAMES,
  type ActivityEntry,
  type Api,
  type BotStatus,
  type Platform,
  type Project,
  type Status,
  type ThreadSummary,
} from "./api.ts";

export type Threads = { projects: Project[]; threads: ThreadSummary[] };

export type Route =
  | { page: "bot"; id: string }
  | { page: "add"; platform: Platform }
  | { page: "settings" }
  | { page: "home" };

export function go(route: Route) {
  location.hash =
    route.page === "bot"
      ? `/bot/${route.id}`
      : route.page === "add"
        ? `/add/${route.platform}`
        : route.page === "home"
          ? ""
          : `/${route.page}`;
}

export function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export const PLATFORMS: ReadonlyArray<Platform> = ["slack", "discord", "telegram"];

// ── bot state ─────────────────────────────────────────────────────────────

export type Tone = "idle" | "working" | "waiting" | "problem" | "off";

/** The one line that says what a bot is up to, shown in the same pill everywhere. */
export function botState(bot: BotStatus, t3: Status["t3"]): { label: string; tone: Tone; detail?: string } {
  if (!bot.enabled) return { label: "Turned off", tone: "off" };
  if (bot.connection.state === "connecting") return { label: "Connecting…", tone: "off" };
  if (bot.connection.state !== "connected")
    return { label: "Not connected", tone: "problem", ...(bot.connection.error ? { detail: bot.connection.error } : {}) };
  if (t3.state !== "connected") return { label: "T3 Code not connected", tone: "problem" };
  if (bot.threadId === null) return { label: "No thread picked", tone: "problem" };
  const working = bot.activity.working;
  if (working?.waiting) return { label: "Waiting for you", tone: "waiting" };
  if (working !== null) return { label: "Working", tone: "working" };
  if (bot.manifestOutdated) return { label: "Slack app needs an update", tone: "problem" };
  return { label: "Idle", tone: "idle" };
}

/** The account the bot runs as, e.g. "@helper · acme". */
export function botHandle(bot: BotStatus) {
  const identity = bot.connection.identity;
  if (bot.platform === "slack" && identity?.includes(" @ ")) {
    const [user, team] = identity.split(" @ ");
    return `@${user} · ${team}`;
  }
  if (bot.account?.username) return `@${bot.account.username}`;
  return identity?.replace(/ on (Discord|Telegram)$/, "") ?? "";
}

/** Where the "Open in …" buttons go. Slack has no link to one app, so it opens Slack itself. */
export function openLink(bot: BotStatus) {
  if (bot.platform === "telegram") return bot.chatLink ?? "https://web.telegram.org";
  if (bot.platform === "discord") return "https://discord.com/channels/@me";
  return "slack://open";
}

export function threadMeta(thread: ThreadSummary | undefined) {
  return thread ? `${thread.projectTitle} · ${thread.model}` : "";
}

/** Each bot's recent requests, for counts the status summary doesn't carry. */
export function useActivities(api: Api, botIds: ReadonlyArray<string>) {
  const [entries, setEntries] = useState<Record<string, ActivityEntry[]>>({});
  const key = botIds.join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    const load = () =>
      void Promise.all(ids.map((id) => api.activity(id).then((result) => [id, result.entries] as const)))
        .then((pairs) => setEntries(Object.fromEntries(pairs)))
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [api, key]);
  return entries;
}

export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// ── pieces ────────────────────────────────────────────────────────────────

/** Slack's mark in lucide's style; lucide dropped brand icons. */
export function SlackIcon({ size = 16, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="3" height="8" x="13" y="2" rx="1.5" />
      <path d="M19 8.5V10h1.5A1.5 1.5 0 1 0 19 8.5" />
      <rect width="3" height="8" x="8" y="14" rx="1.5" />
      <path d="M5 15.5V14H3.5A1.5 1.5 0 1 0 5 15.5" />
      <rect width="8" height="3" x="14" y="13" rx="1.5" />
      <path d="M15.5 19H14v1.5a1.5 1.5 0 1 0 1.5-1.5" />
      <rect width="8" height="3" x="2" y="8" rx="1.5" />
      <path d="M8.5 5H10V3.5A1.5 1.5 0 1 0 8.5 5" />
    </svg>
  );
}

const PLATFORM_ICONS: Record<Exclude<Platform, "slack">, LucideIcon> = { discord: Gamepad2, telegram: Send };

export function PlatformGlyph({ platform, size = 16 }: { platform: Platform; size?: number }) {
  if (platform === "slack") return <SlackIcon size={size} />;
  const Icon = PLATFORM_ICONS[platform];
  return <Icon size={size} aria-hidden />;
}

/** The platform's icon on its brand color. */
export function PlatformBadge({ platform, size = 24, round = false }: { platform: Platform; size?: number; round?: boolean }) {
  return (
    <span
      className={`platform-badge ${platform}${round ? " round" : ""}`}
      style={{ width: size, height: size }}
      title={PLATFORM_NAMES[platform]}
    >
      <PlatformGlyph platform={platform} size={Math.round(size * 0.52)} />
    </span>
  );
}

export function StatePill({ label, tone, detail }: { label: string; tone: Tone; detail?: string | undefined }) {
  return (
    <span className={`pill state ${tone}`} title={detail}>
      <span className="dot" />
      {label}
    </span>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch${on ? " on" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
    >
      <span className="knob" />
    </button>
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="box" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <span>{children}</span>
    </label>
  );
}

export function BrandMark() {
  return <span className="logo">t3</span>;
}

/** The row every page starts with: logo and breadcrumb, then one pill button. */
export function TopNav({ crumbs, action }: { crumbs: ReadonlyArray<string>; action?: "cancel" | "back" }) {
  return (
    <div className="nav">
      <a className="brand" href="#">
        <BrandMark />
        <span className="crumbs">{["T3 Bridge", ...crumbs].join("  /  ")}</span>
      </a>
      {action && (
        <button className="pill-btn" onClick={() => go({ page: "home" })}>
          {action === "cancel" ? <X size={15} /> : <ArrowLeft size={15} />}
          {action === "cancel" ? "Cancel" : "All bots"}
        </button>
      )}
    </div>
  );
}

/**
 * A native select drawn like the design's select boxes: an icon, the choice, and up/down
 * chevrons. The real select sits on top, invisible, so phones still get their own picker.
 */
export function SelectBox(props: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  mono?: boolean;
  disabled?: boolean;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={`select-box${props.disabled ? " disabled" : ""}`}>
      {props.icon}
      <span className="select-text">
        <span className={props.mono ? "mono" : "select-title"}>{props.title}</span>
        {props.meta && <span className="select-meta">{props.meta}</span>}
      </span>
      <ChevronsUpDown size={16} className="chev" />
      <select value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)}>
        {props.children}
      </select>
    </div>
  );
}

/** T3 threads grouped by project, pinned ones first, for a thread select. */
export function ThreadOptions({ threads }: { threads: Threads }) {
  return (
    <>
      {threads.projects
        .map((project) => ({
          project,
          threads: threads.threads
            .filter((thread) => thread.projectId === project.id)
            .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
        }))
        .filter((group) => group.threads.length > 0)
        .map((group) => (
          <optgroup key={group.project.id} label={group.project.title}>
            {group.threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.pinned ? "📌 " : ""}
                {thread.title} · {thread.model}
              </option>
            ))}
          </optgroup>
        ))}
    </>
  );
}

/**
 * T3 Bridge serves this page over plain http on the tailnet, where browsers withhold the
 * clipboard API; the old execCommand copy still works there.
 */
export function copyText(text: string) {
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

export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text) => {
      copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
  ];
}

export function useQr(link: string | undefined) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (link === undefined) return;
    void QRCode.toDataURL(link, { margin: 0, width: 328 }).then(setQr);
  }, [link]);
  return qr;
}

/** The panel link with its token hidden, for showing on screen. */
export function maskedLink(link: string) {
  return link.replace(/token=.*/, "token=••••••••••");
}

export function useManifest(api: Api, name: string) {
  const [manifest, setManifest] = useState<unknown>(null);
  useEffect(() => {
    void api.manifest(name || "T3 Bridge").then(setManifest);
  }, [api, name]);
  return manifest === null ? null : { json: manifest, text: JSON.stringify(manifest, null, 2) };
}

/** Slack opens "Create app" with this manifest already filled in. */
export function slackCreateUrl(manifest: unknown) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/** The manifest itself, for copying by hand when the link or the clipboard is blocked. */
export function ManifestText({ text }: { text: string }) {
  const [copied, copy] = useCopied();
  return (
    <details className="manifest">
      <summary>Or copy the manifest by hand</summary>
      <button className="btn outline sm" onClick={() => copy(text)}>
        {copied ? "Copied" : "Copy manifest"}
      </button>
      <textarea className="input mono" rows={8} readOnly value={text} onFocus={(event) => event.currentTarget.select()} />
    </details>
  );
}
