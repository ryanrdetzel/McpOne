import { describe, expect, it } from "vitest";
import { parseStrictJson, readJsonBody } from "../src/strict-json";

describe("execution transport JSON safety", () => {
  it("rejects nested and escaped duplicate names rather than fingerprinting a discarded value", () => {
    for (const source of [
      '{"arguments":{"value":1,"value":2}}',
      '{"value":1,"\\u0076alue":2}',
      '[{"x":1,"x":2}]',
    ]) {
      expect(() => parseStrictJson(source)).toThrow("Duplicate JSON property");
    }
  });

  it("preserves equal names in separate objects, array order and string escapes", () => {
    expect(
      parseStrictJson(
        '{"left":{"x":1},"right":{"x":2},"array":[true,null,"a\\"b",-2]}',
      ),
    ).toEqual({
      left: { x: 1 },
      right: { x: 2 },
      array: [true, null, 'a"b', -2],
    });
  });

  it("rejects excessive nesting before recursive canonicalization", () => {
    expect(() =>
      parseStrictJson(`${"[".repeat(66)}0${"]".repeat(66)}`),
    ).toThrow("JSON nesting limit");
  });

  it("bounds actual streamed bytes even without Content-Length", async () => {
    const request = new Request("http://localhost/mcp/profile", {
      method: "POST",
      body: '{"value":"oversized"}',
    });
    await expect(readJsonBody(request, 8)).rejects.toThrow("Payload limit");
    const valid = new Request("http://localhost/mcp/profile", {
      method: "POST",
      body: '{"value":1}',
    });
    expect(await readJsonBody(valid, 11)).toEqual({ value: 1 });
  });

  it("rejects invalid UTF-8 instead of repairing business arguments", async () => {
    const request = new Request("http://localhost/mcp/profile", {
      method: "POST",
      body: new Uint8Array([123, 34, 120, 34, 58, 34, 0xff, 34, 125]),
    });
    await expect(readJsonBody(request)).rejects.toThrow();
  });
});
