/**
 * A Telegram message holds 4,096 characters after formatting is applied. Chunks are cut from
 * the markdown before it becomes HTML, with room left for markup Telegram does not count.
 */
export const TELEGRAM_MESSAGE_LIMIT = 3500;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Converts common markdown to the HTML subset Telegram accepts (b, i, s, code, pre, a,
 * blockquote). Telegram has no headings, lists or tables: headings become bold lines, bullets
 * become •, and tables go into a <pre> block so their columns still line up.
 */
export function toTelegramHtml(markdown: string): string {
  return markdown
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```([^\n]*)\n([\s\S]*?)\n?```$/.exec(part);
      if (fence !== null) {
        const language = fence[1]!.trim();
        const code = escapeHtml(fence[2]!);
        return language
          ? `<pre><code class="language-${escapeHtml(language)}">${code}</code></pre>`
          : `<pre>${code}</pre>`;
      }
      return textToHtml(part);
    })
    .join("");
}

function textToHtml(text: string): string {
  // Tables first, so their cells are not read as markdown.
  return text
    .split(/((?:^\|.*\|[ \t]*(?:\n|$))+)/m)
    .map((part) => (/^\|.*\|/.test(part) ? `<pre>${escapeHtml(part.replace(/\n$/, ""))}</pre>\n` : quotes(part)))
    .join("");
}

/** Groups "> " lines into blockquotes. */
function quotes(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (quote.length > 0) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  for (const line of lines) {
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted !== null) quote.push(inline(quoted[1]!));
    else {
      flush();
      out.push(inline(line));
    }
  }
  flush();
  return out.join("\n");
}

/** One line of markdown; inline code is kept apart so nothing inside it is formatted. */
function inline(line: string): string {
  return line
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/^#{1,6}\s+(.+)$/, "<b>$1</b>")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => link(url, label || url))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => link(url, label))
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/(^|[^\w])__(.+?)__(?!\w)/g, "$1<b>$2</b>")
        .replace(/~~(.+?)~~/g, "<s>$1</s>")
        .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>")
        .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>");
    })
    .join("");
}

function link(url: string, label: string) {
  return /^https?:\/\//.test(url) ? `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>` : label;
}
