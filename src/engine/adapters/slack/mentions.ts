/** Slack notifies a person only for `<@USERID>`; the agent knows people by name. */

const SLACK_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export interface SlackPerson {
  readonly id: string;
  readonly names: ReadonlyArray<string | undefined>;
}

/** Names that point at people: lowercased name to the ids that carry it. */
export type Directory = ReadonlyMap<string, ReadonlySet<string>>;

/** Each person under their full names and first name. A name two people share maps to both. */
export function buildDirectory(people: Iterable<SlackPerson>): Directory {
  const directory = new Map<string, Set<string>>();
  for (const person of people) {
    const names = person.names.flatMap((name) => {
      const trimmed = name?.trim() ?? "";
      return trimmed ? [trimmed, trimmed.split(/\s+/)[0]!] : [];
    });
    for (const name of names) {
      if (name.length < 2) continue;
      const key = name.toLowerCase();
      const ids = directory.get(key) ?? new Set<string>();
      ids.add(person.id);
      directory.set(key, ids);
    }
  }
  return directory;
}

/** User ids mentioned in Slack text. */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(SLACK_MENTION)].map((match) => match[1]!))];
}

/** Shows the agent who a mention is, keeping the id so it can mention them back. */
export function nameMentions(text: string, nameOf: ReadonlyMap<string, string>): string {
  return text.replace(SLACK_MENTION, (_, id: string) => {
    const name = nameOf.get(id);
    return name && name !== id ? `@${name} (<@${id}>)` : `<@${id}>`;
  });
}

/** Whether text may hold an `@Name` worth looking up. */
export function mayMention(markdown: string): boolean {
  return /(?<![\p{L}\p{N}_<.])@\p{L}/u.test(markdown);
}

/**
 * Turns `@Name` in the agent's markdown into a Slack mention. Names that match no one, or more
 * than one person, stay as text, and so does anything inside code.
 */
export function linkMentions(markdown: string, directory: Directory): string {
  const names = [...directory.keys()]
    .filter((name) => directory.get(name)!.size === 1)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return markdown;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_<.])@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])( \\(<@[UW][A-Z0-9]+>\\))?`,
    "giu",
  );
  return markdown
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(pattern, (whole, name: string, echoed: string | undefined) => {
            // The agent repeating the "@Name (<@ID>)" it was shown keeps just the mention.
            if (echoed) return echoed.slice(2, -1);
            const [id] = directory.get(name.toLowerCase())!;
            return id ? `<@${id}>` : whole;
          }),
    )
    .join("");
}

/**
 * While a reply streams, a name at the very end may still be growing ("@Ty" becomes
 * "@Tyler Channell"). Streamed text cannot be rewritten, so a recent `@` waits for more text.
 */
export function holdBackMention(markdown: string): string {
  const at = markdown.search(/(?<![\p{L}\p{N}_<.])@\p{L}[^@\n]{0,40}$/u);
  return at === -1 ? markdown : markdown.slice(0, at);
}

/** Canvases take mentions in their own markdown form. */
export function canvasMentions(markdown: string): string {
  return markdown.replace(SLACK_MENTION, (_, id: string) => `![](@${id})`);
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
