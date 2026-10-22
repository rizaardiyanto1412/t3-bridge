export interface Logger {
  readonly info: (message: string) => void;
  readonly warn: (message: string, error?: unknown) => void;
  readonly error: (message: string, error?: unknown) => void;
}

export interface LogEntry {
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

/** Keeps the last few hundred lines so the control panel can show what happened. */
export function makeLogger(sink: (line: string) => void = (line) => console.log(line)) {
  const entries: LogEntry[] = [];
  const write = (level: LogEntry["level"], message: string, error?: unknown) => {
    const detail =
      error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
    const entry = { at: new Date().toISOString(), level, message: `${message}${detail}` };
    entries.push(entry);
    if (entries.length > 500) entries.splice(0, entries.length - 500);
    sink(`[${entry.at}] ${level.toUpperCase()} ${entry.message}`);
  };
  const logger: Logger & { readonly entries: () => ReadonlyArray<LogEntry> } = {
    info: (message) => write("info", message),
    warn: (message, error) => write("warn", message, error),
    error: (message, error) => write("error", message, error),
    entries: () => entries,
  };
  return logger;
}
