/** Discord messages hold at most 2,000 characters; leave room for the "writing…" note. */
export const DISCORD_MESSAGE_LIMIT = 1900;

/**
 * Discord draws most markdown itself. It has only three heading levels and no tables, so
 * deeper headings become bold lines and tables go into a code block, where columns still line up.
 */
export function toDiscordMarkdown(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return part;
      return part
        .replace(/^#{4,6}\s+(.+)$/gm, "**$1**")
        .replace(/(^\|.*\|[ \t]*$\n?)+/gm, (table) => `\`\`\`\n${table.replace(/\n$/, "")}\n\`\`\`\n`);
    })
    .join("");
}

/** Discord mentions look like <@123>; the agent reads them better as @name. */
export function decodeDiscordText(
  text: string,
  names: ReadonlyMap<string, string>,
  botUserId: string,
): string {
  return text
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .replace(/<@!?(\d+)>/g, (match, id: string) => (names.has(id) ? `@${names.get(id)}` : match))
    .trim();
}
