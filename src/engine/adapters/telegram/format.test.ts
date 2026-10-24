import { describe, expect, it } from "vitest";

import { toTelegramHtml } from "./format.ts";

describe("toTelegramHtml", () => {
  it("converts headings, emphasis, links and bullets, and escapes HTML", () => {
    expect(
      toTelegramHtml("# Title\n**bold** and *it* in snake_case_name\n- [docs](https://x.dev) a < b & c"),
    ).toBe(
      '<b>Title</b>\n<b>bold</b> and <i>it</i> in snake_case_name\n• <a href="https://x.dev">docs</a> a &lt; b &amp; c',
    );
  });

  it("keeps code as code, with nothing inside it formatted", () => {
    expect(toTelegramHtml("```ts\nif (a < b) { x = **y** }\n```\nthen `a_b_c`")).toBe(
      '<pre><code class="language-ts">if (a &lt; b) { x = **y** }</code></pre>\nthen <code>a_b_c</code>',
    );
  });

  it("puts tables in a pre block and groups quotes", () => {
    expect(toTelegramHtml("| a | b |\n|---|---|\n| 1 | 2 |\nafter")).toBe(
      "<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>\nafter",
    );
    expect(toTelegramHtml("> one\n> two\nplain")).toBe("<blockquote>one\ntwo</blockquote>\nplain");
  });

  it("leaves arithmetic and lone asterisks alone", () => {
    expect(toTelegramHtml("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24");
  });
});
