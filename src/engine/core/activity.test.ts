import { describe, expect, it } from "vitest";

import { applyPost, applyRunStatus, isWorking, newActivity } from "./activity.ts";

const task = (id: string, status: "running" | "completed") => ({
  id,
  title: `Task ${id}`,
  model: "m",
  status,
  progress: null,
  result: null,
});

describe("activity", () => {
  it("stays working while subagents run after the orchestrator's turn ends", () => {
    let entry = newActivity({ id: "m1", user: "Riza", text: "Fix #1929", files: 1 });
    entry = applyPost(entry, { kind: "subagents", tasks: [task("a", "completed"), task("b", "running")] });
    entry = applyRunStatus(entry, "completed");
    expect(isWorking(entry)).toBe(true);
    entry = applyPost(entry, { kind: "subagents", tasks: [task("a", "completed"), task("b", "completed")] });
    expect(isWorking(entry)).toBe(false);
    expect(entry.subagents.map((subagent) => subagent.status)).toEqual(["completed", "completed"]);
  });

  it("tracks open questions and the latest reply", () => {
    let entry = newActivity({ id: "m1", user: "Riza", text: "Merge it?", files: 0 });
    const question = { kind: "question", threadId: "t", requestId: "r", source: "Orchestrator", questions: [] } as const;
    entry = applyPost(entry, { ...question, resolved: false });
    expect(entry.waiting).toBe("question");
    entry = applyPost(entry, { ...question, resolved: true });
    expect(entry.waiting).toBeNull();
    entry = applyPost(entry, { kind: "assistant", markdown: "Merged.", streaming: false, images: [] });
    expect(entry.reply).toBe("Merged.");
  });
});
