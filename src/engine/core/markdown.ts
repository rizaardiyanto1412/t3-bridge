/** Markdown helpers every chat platform needs: splitting to message limits and long-report previews. */

/** Splits markdown into chunks under the limit, preferring paragraph and line breaks, never inside a code fence. */
export function splitMarkdown(markdown: string, limit: number): string[] {
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

/** A long report is titled after its first heading, or its first line. */
export function reportTitle(markdown: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1];
  const firstLine = markdown.trim().split("\n")[0] ?? "";
  const title = (heading ?? firstLine).replace(/[*_`#>]/g, "").trim();
  return truncate(title || "Report", 120);
}

/** The opening of a long reply, cut at a paragraph break, shown in chat beside the full report. */
export function reportPreview(markdown: string, limit = 900): string {
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
