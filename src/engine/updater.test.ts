import { describe, expect, it } from "vitest";

import { newerThan } from "./updater.ts";

describe("newerThan", () => {
  it("compares numerically, part by part", () => {
    expect(newerThan("0.10.0", "0.9.3")).toBe(true);
    expect(newerThan("1.0.0", "0.99.99")).toBe(true);
    expect(newerThan("0.1.0", "0.1.0")).toBe(false);
    expect(newerThan("0.1.0", "0.2.0")).toBe(false);
  });
});
