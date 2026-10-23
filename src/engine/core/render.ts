import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2RunStatus,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

import type {
  ImageRef,
  OutboundPost,
  Question,
  RunStatus,
  SubagentStatus,
  SubagentTask,
} from "./types.ts";

export interface RenderContext {
  readonly threadId: string;
  readonly nodes: ReadonlyMap<string, OrchestrationV2ExecutionNode>;
  readonly requests: ReadonlyMap<string, OrchestrationV2RuntimeRequest>;
  /** Messages the bridge itself sent; they are not echoed back to chat. */
  readonly sentByBridge: (messageId: string) => boolean;
  /** An image file on this Mac that the agent referenced by path. */
  readonly localImage: (path: string) => ImageRef;
  readonly attachmentImage: (attachment: {
    id: string;
    name: string;
    mimeType: string;
  }) => ImageRef;
  readonly htmlRender: (reference: { attachmentId: string; title: string }) => ImageRef;
}

export interface KeyedPost {
  readonly key: string;
  readonly post: OutboundPost;
}

/** True when the node runs inside a provider-native subagent, whose chatter stays out of chat. */
export function isInsideSubagent(
  nodeId: string | null,
  nodes: ReadonlyMap<string, OrchestrationV2ExecutionNode>,
): boolean {
  let current = nodeId === null ? undefined : nodes.get(nodeId);
  for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
    if (current.kind === "subagent") return true;
    current = current.parentNodeId === null ? undefined : nodes.get(current.parentNodeId);
  }
  return false;
}

const APPROVAL_DEFAULTS: ReadonlyArray<ProviderApprovalDecision> = [
  "accept",
  "acceptForSession",
  "decline",
];

export function requestKey(threadId: string, requestId: string) {
  return `r:${threadId}:${requestId}`;
}

/**
 * Turns one turn item of the orchestrator thread into the chat post that represents it, or
 * null when it stays out of chat. Pure, so the same item always maps to the same post and
 * re-rendering after a reconnect never duplicates anything.
 */
export function postForTurnItem(
  item: OrchestrationV2TurnItem,
  context: RenderContext,
): KeyedPost | null {
  if ("nodeId" in item && isInsideSubagent(item.nodeId, context.nodes)) return null;
  switch (item.type) {
    case "assistant_message": {
      const local = extractLocalImages(item.text);
      const images = [
        ...(item.attachments ?? [])
          .filter((attachment) => attachment.type === "image")
          .map((attachment) => context.attachmentImage(attachment)),
        ...local.paths.map((path) => context.localImage(path)),
      ];
      if (local.markdown.trim().length === 0 && images.length === 0) return null;
      return {
        key: `a:${item.id}`,
        post: { kind: "assistant", markdown: local.markdown, streaming: item.streaming, images },
      };
    }
    case "user_message": {
      if (item.createdBy !== "user" || context.sentByBridge(item.messageId)) return null;
      if (item.text.trim().length === 0) return null;
      return { key: `u:${item.messageId}`, post: { kind: "echo", markdown: item.text } };
    }
    case "approval_request": {
      const request = context.requests.get(item.requestId);
      return {
        key: requestKey(context.threadId, item.requestId),
        post: approvalPost(context.threadId, item, request, "Orchestrator"),
      };
    }
    case "user_input_request": {
      const request = context.requests.get(item.requestId);
      return {
        key: requestKey(context.threadId, item.requestId),
        post: questionPost(context.threadId, item, request, "Orchestrator"),
      };
    }
    case "proposed_plan":
      if (item.streaming || item.markdown.trim().length === 0) return null;
      return { key: `p:${item.id}`, post: { kind: "plan", markdown: item.markdown } };
    case "todo_list":
      if (item.steps.length === 0) return null;
      return {
        key: `t:${item.id}`,
        post: {
          kind: "todo",
          steps: item.steps.map((step) => ({ text: step.text, status: step.status })),
        },
      };
    case "error":
      return { key: `e:${item.id}`, post: { kind: "error", message: item.failure.message } };
    case "dynamic_tool": {
      if (item.status !== "completed") return null;
      const reference = htmlRenderFromToolItem(item);
      if (reference === undefined) return null;
      return {
        key: `h:${item.id}`,
        post: { kind: "html", title: reference.title, html: context.htmlRender(reference) },
      };
    }
    default:
      return null;
  }
}

export function approvalPost(
  threadId: string,
  item: Extract<OrchestrationV2TurnItem, { type: "approval_request" }>,
  request: OrchestrationV2RuntimeRequest | undefined,
  source: string,
): OutboundPost {
  const decisions = item.options?.map((option) => option.decision) ?? APPROVAL_DEFAULTS;
  return {
    kind: "approval",
    threadId,
    requestId: item.requestId,
    source,
    prompt: item.prompt ?? item.title ?? `The agent wants to run a ${item.requestKind} action.`,
    decisions: decisions.filter((decision) => decision !== "cancel"),
    resolved: resolvedDecision(item.status, request),
  };
}

function resolvedDecision(
  itemStatus: OrchestrationV2TurnItem["status"],
  request: OrchestrationV2RuntimeRequest | undefined,
): ProviderApprovalDecision | "expired" | null {
  if (request === undefined)
    return itemStatus === "waiting" || itemStatus === "pending" ? null : "expired";
  if (request.status === "pending") return null;
  if (request.status === "resolved") return request.decision ?? "accept";
  return "expired";
}

export function questionPost(
  threadId: string,
  item: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>,
  request: OrchestrationV2RuntimeRequest | undefined,
  source: string,
): OutboundPost {
  const questions: Question[] = item.questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
      value: option.value ?? option.label,
    })),
    multiSelect: question.multiSelect === true,
    allowCustomAnswer: question.allowCustomAnswer !== false,
  }));
  return {
    kind: "question",
    threadId,
    requestId: item.requestId,
    source,
    questions,
    resolved: resolvedDecision(item.status, request) !== null,
  };
}

export function subagentPost(subagent: OrchestrationV2Subagent): OutboundPost {
  return { kind: "subagent", ...subagentTask(subagent) };
}

export function subagentTask(subagent: OrchestrationV2Subagent): SubagentTask {
  return {
    id: subagent.id,
    title: subagent.title ?? firstLine(subagent.prompt),
    model: subagent.modelSelection?.model ?? subagent.model,
    status: subagentStatus(subagent.status),
    progress: subagent.progress ?? null,
    result: subagent.result,
  };
}

function subagentStatus(status: OrchestrationV2Subagent["status"]): SubagentStatus {
  switch (status) {
    case "idle":
    case "pending":
      return "pending";
    case "interrupted":
      return "cancelled";
    default:
      return status;
  }
}

export function runStatus(status: OrchestrationV2RunStatus): RunStatus | null {
  switch (status) {
    case "preparing":
    case "queued":
      return null;
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "interrupted";
  }
}

function firstLine(text: string) {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Subagent";
}

const LOCAL_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Agents show screenshots as markdown images pointing at a file on the host, e.g.
 * `![shot](/Users/me/.t3/userdata/browser-artifacts/shot.png)`. T3 serves those itself; chat
 * apps would only see the path. Such images are taken out of the text to be uploaded as
 * files. A half-streamed image at the end of the text is held back until it is complete.
 */
export function extractLocalImages(markdown: string): { markdown: string; paths: string[] } {
  const paths: string[] = [];
  const text = markdown
    .replace(/!\[[^\]]*\]\(\s*<?((?:file:\/\/)?\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (match, target: string) => {
      const path = decodeURIComponent(target.replace(/^file:\/\//, "").split(/[?#]/)[0]!);
      if (!LOCAL_IMAGE_EXTENSIONS.test(path)) return match;
      if (!paths.includes(path)) paths.push(path);
      return "";
    })
    .replace(/!\[[^\]]*(?:\]\([^)]*)?$/, "")
    .replace(/\n{3,}/g, "\n\n");
  return { markdown: text, paths };
}

/** Stable fingerprint of what a post shows, so unchanged posts are not edited again. */
export function postFingerprint(post: OutboundPost): string {
  return JSON.stringify(post, (_key, value: unknown) =>
    typeof value === "function" ? undefined : value,
  );
}

export const ORCHESTRATOR_REMINDER =
  "[via chat · you are the orchestrator: delegate all work to subagents with delegate_task]";

export const DEFAULT_INSTRUCTIONS = `You are the orchestrator for this project. Messages from the user reach you through a chat app (Slack) via T3 Bridge; your replies are posted back there.

- Never edit files, run commands, or do the work yourself. Always delegate to subagents with the t3-code delegate_task tool (mode "async"), giving each subagent a complete, self-contained brief.
- Choose the subagent model to fit the task: a strong model for hard work, a fast one for small chores. Run independent tasks in parallel.
- When subagents finish, reply with a short summary: what changed, test status, and anything that needs the user's decision.
- You may answer quick questions directly only when no code needs to be read or changed.
- Keep replies concise and chat-friendly. Use short paragraphs and lists; avoid wide tables.
- Images you show (by file path or attachment) and pages you render with html_render reach the user in Slack as files, so do not tell them to open T3 to see them.`;
