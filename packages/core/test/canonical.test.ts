import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../src/execution/canonical";

describe("M1 RFC 8785 identity", () => {
  it("matches the frozen public digest vector", async () => {
    const frame = {
      version: "m1",
      organization_id: "org-example",
      grant_id: "grant-example",
      profile_id: "profile-example",
      tool: "fixture.counter.increment",
      tool_revision: "fixture-v1",
      accounts: {},
      options: {},
      arguments: { value: 1, note: "public fixture" },
    };
    expect(await sha256(canonicalJson(frame))).toBe(
      "8cd9a3ce89fd376830423a084000fa13e1062c3fb8d590e228794b4c0562f8fe",
    );
  });
  it("orders UTF-16 keys without normalizing strings, arrays, or JSON types", () => {
    expect(
      canonicalJson({ z: -0, a: [1, "1"], "\ud83d\ude00": 2, "\ufffd": 3 }),
    ).toBe('{"a":[1,"1"],"z":0,"\ud83d\ude00":2,"\ufffd":3}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({})).not.toBe(canonicalJson({ value: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it("rejects unsupported numbers, Unicode, object values, cycles, and holes", () => {
    for (const value of [
      NaN,
      Infinity,
      { a: undefined },
      { a: "\ud800" },
      { "\udc00": 1 },
      new Date(),
      Array(1),
    ]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalJson(cyclic)).toThrow();
  });
});
