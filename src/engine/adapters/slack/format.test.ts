import { describe, expect, it } from "vitest";

import { toMrkdwn } from "./format.ts";

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
