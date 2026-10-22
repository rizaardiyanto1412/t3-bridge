import { describe, expect, it } from "vitest";

import type { Question } from "../../core/types.ts";
import { answersFromView, renderPost } from "./blocks.ts";

const questions: Question[] = [
  {
    id: "color",
    header: "Color",
    question: "Which color?",
    options: [
      { label: "Red", description: "", value: "red" },
      { label: "Blue", description: "", value: "blue" },
    ],
    multiSelect: false,
    allowCustomAnswer: true,
  },
  {
    id: "sizes",
    header: "Sizes",
    question: "Which sizes?",
    options: [
      { label: "S", description: "", value: "s" },
      { label: "M", description: "", value: "m" },
    ],
    multiSelect: true,
    allowCustomAnswer: false,
  },
];

describe("answersFromView", () => {
  it("prefers a written answer over a selection and reads multi-selects", () => {
    const answers = answersFromView(questions, {
      q0: { choice: { selected_option: { value: "red" } } },
      c0: { text: { value: "  teal please " } },
      q1: { choice: { selected_options: [{ value: "s" }, { value: "m" }] } },
    });
    expect(answers).toEqual({ color: "teal please", sizes: ["s", "m"] });
  });

  it("falls back to the selected option", () => {
    const answers = answersFromView(questions, {
      q0: { choice: { selected_option: { value: "blue" } } },
      q1: { choice: {} },
    });
    expect(answers).toEqual({ color: "blue", sizes: [] });
  });
});

describe("renderPost", () => {
  it("offers buttons for an open approval and drops them once it is answered", () => {
    const open = renderPost({
      kind: "approval",
      threadId: "t",
      requestId: "r",
      source: "Subagent",
      prompt: "Run `rm -rf build`?",
      decisions: ["accept", "decline"],
      resolved: null,
    });
    expect(open.blocks.some((block) => block.type === "actions")).toBe(true);
    const answered = renderPost({
      kind: "approval",
      threadId: "t",
      requestId: "r",
      source: "Subagent",
      prompt: "Run it?",
      decisions: ["accept", "decline"],
      resolved: "decline",
    });
    expect(answered.blocks.some((block) => block.type === "actions")).toBe(false);
    expect(JSON.stringify(answered.blocks)).toContain("Declined");
  });

  it("marks a streaming reply as still being written", () => {
    const rendered = renderPost({
      kind: "assistant",
      markdown: "Hel",
      streaming: true,
      images: [],
    });
    expect(rendered.blocks).toHaveLength(2);
    expect(rendered.blocks[0]).toEqual({ type: "markdown", text: "Hel" });
  });
});
