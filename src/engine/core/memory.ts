import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

/**
 * Project memory: lasting facts about one project (access, where things live, decisions,
 * gotchas) that every orchestrator thread and subagent for that project should know. It is
 * the folder Claude Code already keeps for the project, so the bridge and Claude's own
 * memory share one copy, and each project's facts stay apart from every other project's.
 */
export const MEMORY_INDEX = "MEMORY.md";
/** Claude Code reads about this many lines of the index; the panel warns past it. */
export const MEMORY_LINE_LIMIT = 200;

/** Claude Code names a project's folder after its path, with every other character a dash. */
export function memoryDir(workspaceRoot: string, home = OS.homedir()): string {
  const name = Path.resolve(workspaceRoot).replace(/[^a-zA-Z0-9]/g, "-");
  return Path.join(home, ".claude", "projects", name, "memory");
}

/** Shows a path under the home folder as `~/…`, as the agent and the user would type it. */
export function displayPath(path: string, home = OS.homedir()): string {
  return path === home || path.startsWith(home + Path.sep) ? `~${path.slice(home.length)}` : path;
}

/** The part of the instructions that tells the orchestrator where memory is and how to use it. */
export function memoryInstructions(dir: string): string {
  const index = displayPath(Path.join(dir, MEMORY_INDEX));
  return `Project memory: ${index}, plus the files it links. It holds lasting facts about this project: access, where things live, decisions, and gotchas.

- Before each delegate_task, read it and put the facts that matter into the brief. Subagents work in other folders and cannot see it.
- End every brief with: "If you learn a lasting fact about this project (how to reach a server, where something lives, a gotcha), add a line starting with REMEMBER: to the end of your report."
- When the user tells you a lasting fact, put a line starting with REMEMBER: in your reply. T3 Bridge saves it, and saves subagents' REMEMBER: lines too, then confirms each in chat. You don't need to repeat a subagent's REMEMBER: lines.`;
}

const REMEMBER_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?REMEMBER:(?:\*\*|__)?[ \t]*(.*)$/gim;

/** The facts an agent marked with `REMEMBER:`, one per line. */
export function rememberedFacts(text: string): string[] {
  return [...text.matchAll(REMEMBER_LINE)]
    .map((match) => match[1]!.replace(/\*\*|__/g, "").trim())
    .filter((fact) => fact.length > 0);
}

/** The text without its `REMEMBER:` lines; chat shows the saved facts on their own. */
export function withoutRememberLines(text: string): string {
  return text.replace(REMEMBER_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface MemoryFile {
  readonly name: string;
  readonly text: string;
}

/** Writes to one folder happen one at a time, so two facts saved together both land. */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(dir) ?? Promise.resolve()).then(work, work);
  queues.set(dir, next.catch(() => {}));
  return next;
}

async function readText(file: string): Promise<string> {
  try {
    return await FS.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function writeText(file: string, text: string) {
  // Through a temp file, like the bridge's JSON, so a crash never leaves half a file.
  await FS.mkdir(Path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Crypto.randomUUID()}.tmp`;
  await FS.writeFile(temp, text, { mode: 0o644 });
  await FS.rename(temp, file);
}

function normalized(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Adds a fact to the index as one line, with who said it and when. Returns false when the
 * memory already says the same thing, so a fact reported twice is saved once.
 */
export function rememberFact(
  dir: string,
  fact: string,
  source: string,
  now = new Date(),
): Promise<boolean> {
  return serialized(dir, async () => {
    const file = Path.join(dir, MEMORY_INDEX);
    const current = await readText(file);
    if (normalized(current).includes(normalized(fact))) return false;
    const line = `- ${fact.replace(/\s*\n\s*/g, " ")} _(${source}, ${now.toISOString().slice(0, 10)})_`;
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await writeText(file, `${current}${separator}${line}\n`);
    return true;
  });
}

/** Removes the index lines that contain `text`; returns the lines it removed. */
export function forgetFact(dir: string, text: string): Promise<string[]> {
  return serialized(dir, async () => {
    const file = Path.join(dir, MEMORY_INDEX);
    const lines = (await readText(file)).split("\n");
    const needle = normalized(text);
    const removed = lines.filter((line) => line.trim() !== "" && normalized(line).includes(needle));
    if (removed.length > 0)
      await writeText(file, lines.filter((line) => !removed.includes(line)).join("\n"));
    return removed;
  });
}

/** The index first, then the files it links, by name. */
export async function readMemory(dir: string): Promise<MemoryFile[]> {
  let names: string[];
  try {
    names = (await FS.readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  if (!names.includes(MEMORY_INDEX)) names.push(MEMORY_INDEX);
  names.sort((left, right) =>
    left === MEMORY_INDEX ? -1 : right === MEMORY_INDEX ? 1 : left.localeCompare(right),
  );
  return Promise.all(
    names.map(async (name) => ({ name, text: await readText(Path.join(dir, name)) })),
  );
}

/** Saves one memory file from the control panel. Names stay inside the folder. */
export function writeMemoryFile(dir: string, name: string, text: string): Promise<void> {
  if (!/^[\w.-]+\.md$/.test(name) || name.startsWith("."))
    throw new Error("Memory files are .md files with a plain name.");
  return serialized(dir, async () => {
    const file = Path.join(dir, name);
    if (text.trim() === "" && name !== MEMORY_INDEX) {
      await FS.rm(file, { force: true });
      return;
    }
    await writeText(file, text.endsWith("\n") || text === "" ? text : `${text}\n`);
  });
}
