import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { ButtonStore } from "./ButtonStore.ts";
import { buttonInbound, plainText, postText } from "./chatText.ts";
import type { OutboundPost } from "./types.ts";

const approval: Extract<OutboundPost, { kind: "approval" }> = {
  kind: "approval",
  threadId: "thread-1",
  requestId: "request-1",
  source: "Orchestrator",
  prompt: "Run `rm -rf build`?",
  decisions: ["accept", "acceptForSession", "decline"],
  resolved: null,
};

const question: Extract<OutboundPost, { kind: "question" }> = {
  kind: "question",
  threadId: "thread-1",
  requestId: "request-2",
  source: "Fix login",
  questions: [
    {
      id: "q1",
      header: "Branch",
      question: "Which branch?",
      options: [
        { label: "main", description: "", value: "main" },
        { label: "dev", description: "Staging", value: "dev" },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ],
  resolved: false,
};

describe("postText", () => {
  it("gives an open approval one button per decision, and none once resolved", () => {
    const open = postText(approval);
    expect(open.markdown).toContain("Approval needed");
    expect(open.buttons[0]!.map((button) => [button.label, button.style])).toEqual([
      ["Approve", "primary"],
      ["Approve for session", "secondary"],
      ["Decline", "danger"],
    ]);
    const done = postText({ ...approval, resolved: "accept" });
    expect(done.buttons).toEqual([]);
    expect(done.markdown).toContain("✅ Approved");
  });

  it("offers quick answers for a single choice question and asks for a reply otherwise", () => {
    const quick = postText(question);
    expect(quick.buttons[0]!.map((button) => button.label)).toEqual(["main", "dev"]);
    expect(buttonInbound(quick.buttons[0]![1]!.action, "U1")).toEqual({
      type: "answer",
      userId: "U1",
      threadId: "thread-1",
      requestId: "request-2",
      answers: { q1: "dev" },
    });
    const multi = postText({
      ...question,
      questions: [{ ...question.questions[0]!, multiSelect: true }],
    });
    expect(multi.buttons).toEqual([]);
    expect(multi.markdown).toContain("Reply to this message to answer");
    expect(postText({ ...question, resolved: true }).markdown).toContain("✅ Answered");
  });

  it("lists a request's subagents with their state", () => {
    const text = postText({
      kind: "subagents",
      tasks: [
        { id: "a", title: "Fix login", model: "opus", status: "completed", progress: null, result: "ok" },
        { id: "b", title: "Write tests", model: null, status: "running", progress: "3/5", result: null },
      ],
    });
    expect(text.markdown).toContain("1/2 done");
    expect(text.markdown).toContain("✅ **Fix login**");
    expect(text.markdown).toContain("working · 3/5");
  });
});

describe("plainText", () => {
  it("drops markup but keeps link targets", () => {
    expect(plainText("# Done\n**Fixed** [PR](https://x.dev/1) in `app.ts`")).toBe(
      "Done\nFixed PR (https://x.dev/1) in app.ts",
    );
  });
});

describe("ButtonStore", () => {
  it("gives an action the same short id every time and keeps it across restarts", async () => {
    const dir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-bridge-buttons-"));
    const file = Path.join(dir, "buttons.json");
    const action = postText(approval).buttons[0]![0]!.action;
    const store = new ButtonStore(file);
    const id = await store.put(action);
    expect(id.length).toBeLessThanOrEqual(16);
    expect(await store.put(action)).toBe(id);
    expect(await new ButtonStore(file).get(id)).toEqual(action);
    expect(await store.get("missing")).toBeNull();
    await FS.rm(dir, { recursive: true });
  });
});
