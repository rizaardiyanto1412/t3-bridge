import type { OutboundPost, RunStatus } from "./types.ts";

/** One chat request and what came of it, for the control panel's conversation view. */
export interface ActivityEntry {
  /** The T3 message id the request was sent as. */
  readonly id: string;
  readonly at: string;
  readonly user: string;
  readonly text: string;
  readonly files: number;
  readonly status: RunStatus | "not_sent";
  readonly subagents: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>;
  readonly waiting: "approval" | "question" | null;
  /** The start of the agent's latest reply. */
  readonly reply: string | null;
  readonly error: string | null;
  readonly updatedAt: string;
}

export const MAX_ACTIVITY = 200;
const SNIPPET = 280;

const snippet = (text: string) =>
  text.length > SNIPPET ? `${text.slice(0, SNIPPET).trimEnd()}…` : text;

export function newActivity(input: {
  id: string;
  user: string;
  text: string;
  files: number;
  error?: string;
}): ActivityEntry {
  const at = new Date().toISOString();
  return {
    id: input.id,
    at,
    user: input.user,
    text: snippet(input.text),
    files: input.files,
    status: input.error === undefined ? "running" : "not_sent",
    subagents: [],
    waiting: null,
    reply: null,
    error: input.error ?? null,
    updatedAt: at,
  };
}

/** Folds a post the agent produced for this request into its entry. */
export function applyPost(entry: ActivityEntry, post: OutboundPost): ActivityEntry {
  const touched = { ...entry, updatedAt: new Date().toISOString() };
  switch (post.kind) {
    case "assistant":
      return post.markdown.trim() === "" ? entry : { ...touched, reply: snippet(post.markdown.trim()) };
    case "subagents":
      return {
        ...touched,
        subagents: post.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
      };
    case "subagent": {
      const task = { id: post.id, title: post.title, status: post.status };
      const others = entry.subagents.filter((existing) => existing.id !== post.id);
      return { ...touched, subagents: [...others, task] };
    }
    case "approval":
      return { ...touched, waiting: post.resolved === null ? "approval" : null };
    case "question":
      return { ...touched, waiting: post.resolved ? null : "question" };
    case "error":
      return { ...touched, error: snippet(post.message) };
    default:
      return entry;
  }
}

export function applyRunStatus(entry: ActivityEntry, status: RunStatus): ActivityEntry {
  if (entry.status === status) return entry;
  return { ...entry, status, updatedAt: new Date().toISOString() };
}

/** Whether the agent is still on it: its turn is running or subagents it started still are. */
export function isWorking(entry: ActivityEntry) {
  return (
    entry.status === "running" ||
    entry.subagents.some((task) => ["pending", "running", "waiting"].includes(task.status))
  );
}
