/** Slack's markdown block holds at most 12,000 characters; leave room for a continuation note. */
export const MARKDOWN_BLOCK_LIMIT = 11_500;

/** Splits markdown into chunks under the limit, preferring paragraph and line breaks, never inside a code fence. */
export function splitMarkdown(markdown: string, limit = MARKDOWN_BLOCK_LIMIT): string[] {
  if (markdown.length <= limit) return [markdown];
  const chunks: string[] = [];
  let rest = markdown;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    let chunk = rest.slice(0, cut);
    // An odd number of fences means the cut lands inside a code block: close it here, reopen next.
    const fences = chunk.match(/^```/gm)?.length ?? 0;
    if (fences % 2 === 1) {
      const language = /^```(\S*)/m.exec(chunk.slice(chunk.lastIndexOf("```")))?.[1] ?? "";
      chunk = `${chunk}\n\`\`\``;
      rest = `\`\`\`${language}\n${rest.slice(cut).replace(/^\n/, "")}`;
    } else {
      rest = rest.slice(cut).replace(/^\n+/, "");
    }
    chunks.push(chunk);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
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

/** A canvas is titled after the report's first heading, or its first line. */
export function canvasTitle(markdown: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1];
  const firstLine = markdown.trim().split("\n")[0] ?? "";
  const title = (heading ?? firstLine).replace(/[*_`#>]/g, "").trim();
  return truncate(title || "Report", 120);
}

/** The opening of a long reply, cut at a paragraph break, shown in chat beside the canvas link. */
export function canvasPreview(markdown: string, limit = 900): string {
  const paragraphs = markdown.trim().split(/\n{2,}/);
  let preview = "";
  for (const paragraph of paragraphs) {
    // Headings and tables belong to the report body, not the chat preview.
    if (/^(#|\|)/.test(paragraph.trim()) && preview.length > 0) break;
    if (preview.length + paragraph.length > limit) break;
    preview = preview ? `${preview}\n\n${paragraph}` : paragraph;
  }
  return preview || truncate(paragraphs[0] ?? "", limit);
}

export function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
