import { describe, expect, it } from "vitest";

import { reportPreview, reportTitle, splitMarkdown } from "./markdown.ts";

describe("splitMarkdown", () => {
  it("keeps short text whole", () => {
    expect(splitMarkdown("hello", 100)).toEqual(["hello"]);
  });

  it("splits on paragraph breaks under the limit", () => {
    const text = ["a".repeat(60), "b".repeat(60), "c".repeat(60)].join("\n\n");
    const chunks = splitMarkdown(text, 100);
    expect(chunks.every((chunk) => chunk.length <= 104)).toBe(true);
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("closes and reopens a code fence cut in the middle", () => {
    const code = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const chunks = splitMarkdown(`Intro\n\n\`\`\`ts\n${code}\n\`\`\``, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith("```ts\n")).toBe(true);
  });
});

describe("long reports", () => {
  it("titles a report after its first heading and previews its opening paragraphs", () => {
    const report = "I checked everything.\n\n## GitHub check\n\n| a |\n|---|";
    expect(reportTitle(report)).toBe("GitHub check");
    expect(reportPreview(report)).toBe("I checked everything.");
  });
});
