import { describe, expect, it } from "vitest";
import { resolveLayer, resolvePolicy } from "../src/execution/policy";

describe("M1 policy precedence", () => {
  it("matches descendants only and defaults to Ask", () => {
    expect(
      resolveLayer("fixture", [{ pattern: "fixture.*", decision: "allow" }]),
    ).toBeNull();
    expect(resolvePolicy("fixture.counter.increment", [], [])).toBe("ask");
  });
  it("prefers exact then longest prefix and restrictive tied matches", () => {
    expect(
      resolveLayer("fixture.counter.increment", [
        { pattern: "fixture.*", decision: "block" },
        { pattern: "fixture.counter.*", decision: "ask" },
        { pattern: "fixture.counter.increment", decision: "allow" },
      ]),
    ).toBe("allow");
    expect(
      resolveLayer("fixture.counter.increment", [
        { pattern: "fixture.*", decision: "block" },
        { pattern: "fixture.counter.*", decision: "allow" },
        { pattern: "fixture.counter.*", decision: "ask" },
      ]),
    ).toBe("ask");
    expect(
      resolveLayer("fixture.counter.increment", [
        { pattern: "fixture.counter.increment", decision: "allow" },
        { pattern: "fixture.counter.increment", decision: "block" },
      ]),
    ).toBe("block");
  });
  it("preserves mandatory outer Block, but lets an inner decision override other outer matches", () => {
    expect(
      resolvePolicy(
        "fixture.counter.increment",
        [{ pattern: "fixture.*", decision: "block" }],
        [{ pattern: "fixture.counter.increment", decision: "allow" }],
      ),
    ).toBe("block");
    expect(
      resolvePolicy(
        "fixture.counter.increment",
        [{ pattern: "fixture.*", decision: "ask" }],
        [{ pattern: "fixture.counter.increment", decision: "allow" }],
      ),
    ).toBe("allow");
  });
});
