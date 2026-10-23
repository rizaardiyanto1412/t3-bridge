import type { ProviderApprovalDecision } from "@t3tools/contracts";

import { truncate } from "./markdown.ts";
import type {
  InboundAction,
  OutboundPost,
  RunStatus,
  SubagentStatus,
  SubagentTask,
} from "./types.ts";

/**
 * Posts as plain markdown plus buttons, for chat platforms without Slack's block layouts
 * (Discord, Telegram). Each adapter turns the markdown into its own dialect.
 */

/** What a button does when pressed; stored by the adapter under a short id. */
export type ButtonAction =
  | {
      readonly type: "approval";
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: ProviderApprovalDecision;
    }
  | {
      readonly type: "answer";
      readonly threadId: string;
      readonly requestId: string;
      readonly questionId: string;
      readonly value: string;
    };

export interface ChatButton {
  readonly label: string;
  readonly style: "primary" | "secondary" | "danger";
  readonly action: ButtonAction;
}

export interface ChatText {
  readonly markdown: string;
  /** Rows of buttons under the message. */
  readonly buttons: ReadonlyArray<ReadonlyArray<ChatButton>>;
}

export const APPROVAL_LABELS: Record<ProviderApprovalDecision, string> = {
  accept: "Approve",
  acceptForSession: "Approve for session",
  acceptAlways: "Always approve",
  decline: "Decline",
  cancel: "Cancel",
};

const RESOLVED_LABELS: Record<ProviderApprovalDecision | "expired", string> = {
  accept: "✅ Approved",
  acceptForSession: "✅ Approved for this session",
  acceptAlways: "✅ Always approved",
  decline: "🚫 Declined",
  cancel: "🚫 Cancelled",
  expired: "⌛ No longer waiting for an answer",
};

export const SUBAGENT_ICONS: Record<SubagentStatus, string> = {
  pending: "⏳",
  running: "🔄",
  waiting: "⏸️",
  completed: "✅",
  failed: "❌",
  cancelled: "⏹️",
};

const STATUS_LABELS: Record<SubagentStatus, string> = {
  pending: "starting",
  running: "working",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
};

/** A question with at most this many options gets one button per option. */
const MAX_OPTION_BUTTONS = 5;

/** The markdown and buttons of one post. `html` posts are files and have no text of their own. */
export function postText(post: OutboundPost): ChatText {
  switch (post.kind) {
    case "assistant":
      return { markdown: post.markdown, buttons: [] };
    case "echo":
      return { markdown: `💬 **Sent from T3**\n${post.markdown}`, buttons: [] };
    case "notice":
      return { markdown: post.markdown, buttons: [] };
    case "plan":
      return { markdown: `📋 **Proposed plan**\n\n${post.markdown}`, buttons: [] };
    case "todo": {
      const icons = { pending: "⬜", running: "🔄", completed: "✅" } as const;
      const done = post.steps.filter((step) => step.status === "completed").length;
      return {
        markdown: [
          `📝 **Todo** · ${done}/${post.steps.length}`,
          ...post.steps.map((step) => `${icons[step.status]} ${step.text}`),
        ].join("\n"),
        buttons: [],
      };
    }
    case "subagent":
      return { markdown: taskLines(post).join("\n"), buttons: [] };
    case "subagents": {
      const done = post.tasks.filter((task) => task.status === "completed").length;
      const running = post.tasks.some((task) =>
        ["pending", "running", "waiting"].includes(task.status),
      );
      const title = running
        ? `🧩 **Subagents** · ${done}/${post.tasks.length} done`
        : `🧩 **Subagents finished** · ${done}/${post.tasks.length}`;
      return {
        markdown: [title, ...post.tasks.slice(0, 20).flatMap((task) => taskLines(task))].join("\n"),
        buttons: [],
      };
    }
    case "approval": {
      const lines = [`🔐 **Approval needed** · ${post.source}`, truncate(post.prompt, 1500)];
      if (post.resolved !== null) lines.push(`_${RESOLVED_LABELS[post.resolved]}_`);
      const buttons: ChatButton[] =
        post.resolved === null
          ? post.decisions.slice(0, 5).map((decision) => ({
              label: APPROVAL_LABELS[decision],
              style: decision === "accept" ? "primary" : decision === "decline" ? "danger" : "secondary",
              action: {
                type: "approval",
                threadId: post.threadId,
                requestId: post.requestId,
                decision,
              },
            }))
          : [];
      return { markdown: lines.join("\n"), buttons: buttons.length > 0 ? [buttons] : [] };
    }
    case "question":
      return questionText(post);
    case "html":
      return { markdown: `🖼 **${post.title}**`, buttons: [] };
    case "error":
      return { markdown: `❌ **The agent hit an error**\n${post.message}`, buttons: [] };
  }
}

function taskLines(task: SubagentTask): string[] {
  const meta = [task.model, STATUS_LABELS[task.status]].filter(Boolean).join(" · ");
  const progress = task.progress && task.status === "running" ? ` · ${task.progress}` : "";
  return [`${SUBAGENT_ICONS[task.status]} **${task.title}**`, `    _Subagent · ${meta}${progress}_`];
}

function questionText(post: Extract<OutboundPost, { kind: "question" }>): ChatText {
  const lines = [`❓ **The agent has a question** · ${post.source}`];
  for (const question of post.questions) {
    lines.push("", `**${question.header}**`, question.question);
    for (const option of question.options) {
      lines.push(`• **${option.label}**${option.description ? ` — ${option.description}` : ""}`);
    }
  }
  if (post.resolved) return { markdown: [...lines, "", "_✅ Answered_"].join("\n"), buttons: [] };
  // One click answers the whole request only when there is a single, single-choice question.
  const single = post.questions.length === 1 ? post.questions[0] : undefined;
  const quick =
    single !== undefined &&
    !single.multiSelect &&
    single.options.length > 0 &&
    single.options.length <= MAX_OPTION_BUTTONS
      ? single.options.map(
          (option): ChatButton => ({
            label: option.label,
            style: "secondary",
            action: {
              type: "answer",
              threadId: post.threadId,
              requestId: post.requestId,
              questionId: single.id,
              value: option.value,
            },
          }),
        )
      : [];
  lines.push(
    "",
    quick.length > 0
      ? "_Pick an answer, or reply to this message to answer in your own words._"
      : "_Reply to this message to answer._",
  );
  return { markdown: lines.join("\n"), buttons: quick.length > 0 ? [quick] : [] };
}

/** What pressing a button means, from the person who pressed it. */
export function buttonInbound(action: ButtonAction, userId: string): InboundAction {
  return action.type === "approval"
    ? {
        type: "approval",
        userId,
        threadId: action.threadId,
        requestId: action.requestId,
        decision: action.decision,
      }
    : {
        type: "answer",
        userId,
        threadId: action.threadId,
        requestId: action.requestId,
        answers: { [action.questionId]: action.value },
      };
}

/** Run states shown as reactions on the message that started the run. */
export const RUN_EMOJI: Record<RunStatus, string> = {
  running: "👀",
  completed: "✅",
  failed: "❌",
  interrupted: "⏹️",
};

/** Reactions that stop the agent, like Slack's :octagonal_sign:. */
export const STOP_EMOJI = new Set(["🛑", "⛔"]);

/** Finished replies longer than this are previewed in chat; the whole reply is attached as a file. */
export const LONG_REPLY = 6000;

/** A file name made from a title, e.g. for a long reply or a rendered page. */
export function safeFileName(title: string) {
  return (
    title
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}

/** Markdown reduced to readable plain text, for when a platform rejects formatted text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}
