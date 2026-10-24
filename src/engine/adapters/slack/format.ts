import { splitMarkdown } from "../../core/markdown.ts";

/** Slack's markdown block holds at most 12,000 characters; leave room for a continuation note. */
export const MARKDOWN_BLOCK_LIMIT = 11_500;

/** Splits markdown to fit Slack's markdown block. */
export function splitSlackMarkdown(markdown: string): string[] {
  return splitMarkdown(markdown, MARKDOWN_BLOCK_LIMIT);
}

/**
 * Plain-text fallback for notifications and clients that cannot draw markdown blocks.
 * Slack shows it in push notifications, so keep it short and strip markup noise.
 */
export function notificationText(markdown: string, limit = 280): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain || " ";
}

/** Converts common markdown to Slack mrkdwn, for section blocks that do not take markdown. */
export function toMrkdwn(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return part.replace(/^```[^\n]*\n/, "```\n");
      return part
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "<$2|$1>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>")
        .replace(/^(\s*)[-*+]\s+/gm, "$1• ");
    })
    .join("");
}



