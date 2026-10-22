import { describe, expect, it } from "vitest";

import { canvasPreview, canvasTitle, splitMarkdown, toMrkdwn } from "./format.ts";

describe("splitMarkdown", () => {
  it("keeps short text whole", () => {
    expect(splitMarkdown("hello")).toEqual(["hello"]);
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

describe("toMrkdwn", () => {
  it("converts bold, headings, links and bullets", () => {
    expect(toMrkdwn("# Title\n**bold** and [docs](https://x.dev)\n- item")).toBe(
      "*Title*\n*bold* and <https://x.dev|docs>\n• item",
    );
  });

  it("leaves code blocks alone and escapes angle brackets outside them", () => {
    expect(toMrkdwn("a < b\n```js\nif (a < b) {}\n```")).toBe("a &lt; b\n```\nif (a < b) {}\n```");
  });
});

describe("canvas helpers", () => {
  it("titles a canvas after its first heading and previews its opening paragraphs", () => {
    const report = "I checked everything.\n\n## GitHub check\n\n| a |\n|---|";
    expect(canvasTitle(report)).toBe("GitHub check");
    expect(canvasPreview(report)).toBe("I checked everything.");
  });
});
