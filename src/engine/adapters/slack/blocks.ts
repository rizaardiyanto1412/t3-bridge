import type { ProviderApprovalDecision } from "@t3tools/contracts";

import type {
  OutboundPost,
  Question,
  RunStatus,
  SubagentStatus,
  SubagentTask,
} from "../../core/types.ts";
import { notificationText, toMrkdwn, truncate } from "./format.ts";

// Block Kit is a wide union; these posts only use a handful of shapes, kept loose on purpose.
export type Block = Record<string, unknown>;

export const ACTION_APPROVAL = "t3:approval";
export const ACTION_ANSWER = "t3:answer";
export const ACTION_ANSWER_MODAL = "t3:answer_modal";
export const VIEW_ANSWER = "t3:answer_view";
export const VIEW_FORWARD = "t3:forward_view";
/** The callback id of the "Send to <bot>" message shortcut in the app manifest. */
export const SHORTCUT_FORWARD = "t3_forward";

const SECTION_LIMIT = 2900;

const APPROVAL_LABELS: Record<ProviderApprovalDecision, string> = {
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

const SUBAGENT_ICONS: Record<SubagentStatus, string> = {
  pending: "⏳",
  running: "🔄",
  waiting: "⏸️",
  completed: "✅",
  failed: "❌",
  cancelled: "⏹️",
};

/** Slack asks for a fresh block_id each time a task card or plan is updated. */
function freshBlockId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function taskFields(task: SubagentTask) {
  const meta = [task.model, statusLabel(task.status)].filter(Boolean).join(" · ");
  const progress = task.progress && task.status === "running" ? task.progress : null;
  const output = task.result ? truncate(task.result, SUBAGENT_CARD_OUTPUT_LIMIT) : null;
  return {
    task_id: truncate(task.id, 200),
    title: truncate(task.title, 200),
    status: TASK_CARD_STATUS[task.status],
    details: richText(`Subagent · ${meta}${progress ? ` · ${progress}` : ""}`),
    ...(output ? { output: richText(output) } : {}),
  };
}

function plainSubagent(task: SubagentTask): Block[] {
  const meta = [task.model, statusLabel(task.status)].filter(Boolean).join(" · ");
  const progress = task.progress && task.status === "running" ? task.progress : null;
  return [
    section(`${SUBAGENT_ICONS[task.status]} *${escapeMrkdwn(task.title)}*`),
    context(`🧩 Subagent · ${meta}${progress ? ` · ${escapeMrkdwn(progress)}` : ""}`),
  ];
}

/**
 * The orchestrator summarizes each subagent's result in its reply, so the card only keeps the
 * start of it, inside the collapsed card, instead of posting it again.
 */
export const SUBAGENT_CARD_OUTPUT_LIMIT = 600;

const TASK_CARD_STATUS: Record<SubagentStatus, "in_progress" | "complete" | "error"> = {
  pending: "in_progress",
  running: "in_progress",
  waiting: "in_progress",
  completed: "complete",
  failed: "error",
  cancelled: "error",
};

const richText = (text: string): Block => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
});

export const RUN_REACTIONS: Record<RunStatus, string> = {
  running: "eyes",
  completed: "white_check_mark",
  failed: "x",
  interrupted: "black_square_for_stop",
};

const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text: truncate(text, SECTION_LIMIT) },
});
const context = (text: string): Block => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: truncate(text, SECTION_LIMIT) }],
});
const markdown = (text: string): Block => ({ type: "markdown", text });
const plain = (text: string, limit = 75) => ({
  type: "plain_text",
  text: truncate(text, limit),
  emoji: true,
});

/** The blocks and notification text of one post. Long markdown is split by the adapter first. */
export function renderPost(
  post: OutboundPost,
  markdownChunk?: string,
): { text: string; blocks: Block[]; fallbacks?: Block[][] } {
  switch (post.kind) {
    case "assistant": {
      const body = markdownChunk ?? post.markdown;
      return {
        text: notificationText(body),
        blocks: [
          ...(body.trim().length > 0 ? [markdown(body)] : []),
          ...(post.streaming ? [context("_✍️ writing…_")] : []),
        ],
      };
    }
    case "echo":
      return {
        text: notificationText(post.markdown),
        blocks: [context("💬 *Sent from T3*"), markdown(markdownChunk ?? post.markdown)],
      };
    case "notice":
      return { text: notificationText(post.markdown), blocks: [markdown(post.markdown)] };
    case "plan":
      return {
        text: `Plan: ${notificationText(post.markdown)}`,
        blocks: [section("📋 *Proposed plan*"), markdown(markdownChunk ?? post.markdown)],
      };
    case "todo": {
      const icons = { pending: "⬜", running: "🔄", completed: "✅" } as const;
      const done = post.steps.filter((step) => step.status === "completed").length;
      return {
        text: `Todo ${done}/${post.steps.length}`,
        blocks: [
          section(
            [
              `📝 *Todo* · ${done}/${post.steps.length}`,
              ...post.steps.map((step) => `${icons[step.status]} ${toMrkdwn(step.text)}`),
            ].join("\n"),
          ),
        ],
      };
    }
    case "subagent":
      return {
        text: `${SUBAGENT_ICONS[post.status]} ${post.title}`,
        // Slack's native task card, the same one AI apps use for agent steps.
        blocks: [{ type: "task_card", block_id: freshBlockId("task"), ...taskFields(post) }],
        fallbacks: [plainSubagent(post)],
      };
    case "subagents": {
      const done = post.tasks.filter((task) => task.status === "completed").length;
      const running = post.tasks.some((task) => TASK_CARD_STATUS[task.status] === "in_progress");
      const title = running
        ? `Subagents · ${done}/${post.tasks.length} done`
        : `Subagents finished · ${done}/${post.tasks.length}`;
      return {
        text: `🧩 ${title}`,
        blocks: [
          {
            type: "plan",
            block_id: freshBlockId("plan"),
            title,
            tasks: post.tasks.slice(0, 50).map(taskFields),
          },
        ],
        // A plan cannot share a message with task cards, so the next best layout is cards only.
        fallbacks: [
          post.tasks
            .slice(0, 50)
            .map((task) => ({
              type: "task_card",
              block_id: freshBlockId("task"),
              ...taskFields(task),
            })),
          post.tasks.slice(0, 20).flatMap(plainSubagent),
        ],
      };
    }
    case "approval": {
      const header = `🔐 *Approval needed* · ${escapeMrkdwn(post.source)}`;
      const prompt = toMrkdwn(post.prompt);
      const blocks: Block[] = [section(`${header}\n${prompt}`)];
      if (post.resolved === null) {
        blocks.push({
          type: "actions",
          elements: post.decisions.slice(0, 5).map((decision) => ({
            type: "button",
            action_id: `${ACTION_APPROVAL}:${decision}`,
            text: plain(APPROVAL_LABELS[decision]),
            value: JSON.stringify({ t: post.threadId, r: post.requestId, d: decision }),
            ...(decision === "accept"
              ? { style: "primary" }
              : decision === "decline"
                ? { style: "danger" }
                : {}),
          })),
        });
      } else {
        blocks.push(context(RESOLVED_LABELS[post.resolved]));
      }
      return { text: `Approval needed: ${notificationText(post.prompt, 200)}`, blocks };
    }
    case "question":
      return renderQuestion(post);
    case "html":
      return { text: `🖼 ${post.title}`, blocks: [section(`🖼 *${escapeMrkdwn(post.title)}*`)] };
    case "error":
      return {
        text: `Error: ${notificationText(post.message, 200)}`,
        blocks: [section(`❌ *The agent hit an error*\n${toMrkdwn(post.message)}`)],
      };
  }
}

function renderQuestion(post: Extract<OutboundPost, { kind: "question" }>) {
  const blocks: Block[] = [section(`❓ *The agent has a question* · ${escapeMrkdwn(post.source)}`)];
  for (const question of post.questions) {
    const options = question.options.map(
      (option) =>
        `• *${escapeMrkdwn(option.label)}*${option.description ? ` — ${escapeMrkdwn(option.description)}` : ""}`,
    );
    blocks.push(
      section(
        [`*${escapeMrkdwn(question.header)}*`, toMrkdwn(question.question), ...options].join("\n"),
      ),
    );
  }
  if (post.resolved) {
    blocks.push(context("✅ Answered"));
  } else {
    const single = post.questions.length === 1 ? post.questions[0] : undefined;
    const quick =
      single !== undefined &&
      !single.multiSelect &&
      single.options.length > 0 &&
      single.options.length <= 4
        ? single.options.map((option, index) => ({
            type: "button",
            action_id: `${ACTION_ANSWER}:${index}`,
            text: plain(option.label),
            value: JSON.stringify({
              t: post.threadId,
              r: post.requestId,
              q: single.id,
              v: option.value,
            }),
          }))
        : [];
    blocks.push({
      type: "actions",
      elements: [
        ...quick,
        {
          type: "button",
          action_id: ACTION_ANSWER_MODAL,
          text: plain(quick.length > 0 ? "Other answer…" : "Answer…"),
          value: JSON.stringify({ t: post.threadId, r: post.requestId }),
          ...(quick.length === 0 ? { style: "primary" } : {}),
        },
      ],
    });
    blocks.push(context("Or reply in this message's thread to answer in your own words."));
  }
  const first = post.questions[0];
  return {
    text: `Question: ${first ? notificationText(first.question, 200) : "the agent needs an answer"}`,
    blocks,
  };
}

/** Classic mrkdwn sections in place of markdown blocks, for clients that reject the newer block. */
export function withoutMarkdownBlocks(blocks: ReadonlyArray<Block>): Block[] {
  return blocks.flatMap((block) => {
    if (block.type !== "markdown") return [block];
    const text = toMrkdwn(String(block.text ?? ""));
    const sections: Block[] = [];
    for (let start = 0; start < text.length && sections.length < 40; start += SECTION_LIMIT) {
      sections.push(section(text.slice(start, start + SECTION_LIMIT)));
    }
    return sections;
  });
}

/** Confirms a "Send to <bot>" shortcut and asks what the agent should do with the message. */
export function forwardModal(id: string, botName: string, author: string, text: string) {
  return {
    type: "modal",
    callback_id: VIEW_FORWARD,
    private_metadata: id,
    title: plain(`Send to ${botName}`, 24),
    submit: plain("Send", 24),
    close: plain("Cancel", 24),
    blocks: [
      context(`From *${escapeMrkdwn(author)}*`),
      section(`> ${escapeMrkdwn(truncate(text || "(no text)", 1500)).replace(/\n/g, "\n> ")}`),
      {
        type: "input",
        block_id: "note",
        optional: true,
        label: plain("What should it do?", 2000),
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          placeholder: plain("e.g. Reply to this customer, or find the bug behind it", 150),
        },
      },
    ],
  };
}

/** A modal with one input per question; option questions get a select, free questions a text box. */
export function answerModal(
  threadId: string,
  requestId: string,
  questions: ReadonlyArray<Question>,
) {
  return {
    type: "modal",
    callback_id: VIEW_ANSWER,
    private_metadata: JSON.stringify({ t: threadId, r: requestId }),
    title: plain("Answer the agent", 24),
    submit: plain("Send", 24),
    close: plain("Cancel", 24),
    blocks: questions.flatMap((question, index): Block[] => {
      const label = plain(question.header, 2000);
      const hint = { type: "plain_text", text: truncate(question.question, 2000) };
      const options = question.options.slice(0, 100).map((option) => ({
        text: plain(option.label),
        value: truncate(option.value, 150),
        ...(option.description ? { description: plain(option.description) } : {}),
      }));
      const blocks: Block[] = [];
      if (options.length > 0) {
        blocks.push({
          type: "input",
          block_id: `q${index}`,
          optional: question.allowCustomAnswer,
          label,
          hint,
          element: {
            type: question.multiSelect ? "multi_static_select" : "static_select",
            action_id: "choice",
            options,
          },
        });
      }
      if (question.allowCustomAnswer || options.length === 0) {
        blocks.push({
          type: "input",
          block_id: `c${index}`,
          optional: options.length > 0,
          label: options.length > 0 ? plain("Or in your own words", 2000) : label,
          ...(options.length > 0 ? {} : { hint }),
          element: { type: "plain_text_input", action_id: "text", multiline: true },
        });
      }
      return blocks;
    }),
  };
}

type ViewValues = Record<
  string,
  Record<
    string,
    {
      value?: string | null;
      selected_option?: { value: string } | null;
      selected_options?: Array<{ value: string }>;
    }
  >
>;

/** Reads the modal back into T3's answer shape; a written answer wins over a selection. */
export function answersFromView(questions: ReadonlyArray<Question>, values: ViewValues) {
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  questions.forEach((question, index) => {
    const custom = values[`c${index}`]?.text?.value?.trim();
    const choice = values[`q${index}`]?.choice;
    if (custom) answers[question.id] = custom;
    else if (question.multiSelect)
      answers[question.id] = (choice?.selected_options ?? []).map((option) => option.value);
    else if (choice?.selected_option) answers[question.id] = choice.selected_option.value;
    else answers[question.id] = "";
  });
  return answers;
}

function statusLabel(status: SubagentStatus) {
  return {
    pending: "starting",
    running: "working",
    waiting: "waiting",
    completed: "done",
    failed: "failed",
    cancelled: "stopped",
  }[status];
}

function escapeMrkdwn(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
