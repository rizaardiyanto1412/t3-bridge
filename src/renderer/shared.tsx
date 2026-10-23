import { useEffect, useState } from "react";

import {
  PLATFORM_NAMES,
  type Api,
  type BotStatus,
  type ModelSelection,
  type Platform,
  type Project,
  type ThreadSummary,
} from "./api.ts";

export type Threads = { projects: Project[]; threads: ThreadSummary[] };

export type Route = { page: "bot"; id: string } | { page: "add" } | { page: "settings" } | { page: "home" };

export function go(route: Route) {
  location.hash = route.page === "bot" ? `/bot/${route.id}` : route.page === "home" ? "" : `/${route.page}`;
}

export function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ago(iso: string | null) {
  if (iso === null) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export type Health = "ok" | "pending" | "bad" | "off";

export function botHealth(bot: BotStatus): Health {
  if (!bot.enabled) return "off";
  if (bot.connection.state === "connected") return "ok";
  if (bot.connection.state === "connecting") return "pending";
  return "bad";
}

export const HEALTH_LABEL: Record<Health, string> = {
  ok: "Connected",
  pending: "Connecting…",
  bad: "Not connected",
  off: "Turned off",
};

export function PlatformIcon({ platform, large = false }: { platform: Platform; large?: boolean }) {
  return (
    <span className={`platform ${platform}${large ? " lg" : ""}`} title={PLATFORM_NAMES[platform]}>
      {PLATFORM_NAMES[platform].slice(0, 1)}
    </span>
  );
}

export function BridgeMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 36 36" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="3.4">
        <circle cx="9" cy="18" r="6" />
        <circle cx="27" cy="18" r="6" />
        <line x1="15" y1="18" x2="21" y2="18" />
      </g>
    </svg>
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

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn sm"
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
  return (
    <details>
      <summary className="small muted">Or copy the manifest by hand</summary>
      <div className="stack tight" style={{ marginTop: 8 }}>
        <div>
          <CopyButton text={text} label="Copy manifest" />
        </div>
        <textarea
          className="input mono"
          rows={8}
          readOnly
          value={text}
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
    </details>
  );
}

export function ThreadPicker(props: {
  api: Api;
  threads: Threads | null;
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
      setError(errorText(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="stack tight">
      <div>
        <div className="segmented">
          <button className={mode === "existing" ? "active" : ""} onClick={() => setMode("existing")}>
            Use a thread I have
          </button>
          <button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>
            Create a new one
          </button>
        </div>
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
            {visible.length === 0 && <p className="muted small" style={{ padding: "0 10px" }}>No threads match.</p>}
          </div>
        </>
      ) : (
        <div className="stack tight">
          <label className="field">
            <span>Project</span>
            <select className="input" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
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
            <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <p className="muted small">The thread is created with full access, pinned, and given the orchestrator instructions.</p>
          <div className="row">
            <button className="btn primary" disabled={!projectId || creating} onClick={() => void create()}>
              {creating ? "Creating…" : "Create and pin thread"}
            </button>
            {error && <span className="error-text small">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
