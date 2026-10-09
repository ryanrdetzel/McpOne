import { describe, expect, it } from "vitest";
import {
  compressionFixtures,
  LIMITS,
} from "../../../scripts/m2-contract-fixtures.mjs";
import {
  createPinnedHttpTransport,
  type PinnedTransportPlatform,
} from "../src/integrations/transport";

// Explicit finite wire injection isolates the ACTUAL shared parser/decoder. It is
// not network, DNS, SNI, Provider, local/hosted or six-cell acceptance evidence.
function wireTransport(frame: Uint8Array, fragmentBytes = 17) {
  const writes: Uint8Array[] = [];
  let closed = 0;
  const platform: PinnedTransportPlatform = {
    async resolve() {
      return ["8.8.8.8"];
    },
    async connect() {
      return {
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let at = 0; at < frame.length; at += fragmentBytes)
              controller.enqueue(frame.subarray(at, at + fragmentBytes));
            controller.close();
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(bytes) {
            writes.push(bytes);
          },
        }),
        close() {
          closed++;
        },
      };
    },
  };
  const transport = createPinnedHttpTransport(platform);
  return {
    request: (maxResponseBytes = LIMITS.inlineBytes!) =>
      transport.request({
        url: "https://public.example.com/fixture",
        method: "GET",
        headers: new Headers(),
        signal: new AbortController().signal,
        maxResponseBytes,
      }),
    writes,
    closed: () => closed,
  };
}

describe("D12 real finite framing and bounded content decoder, explicit wire seam", () => {
  for (const fixture of compressionFixtures())
    it(fixture.name, async () => {
      const head = Buffer.from(
        `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: ${fixture.encoding}\r\nContent-Length: ${fixture.wire.byteLength}\r\nConnection: close\r\n\r\n`,
      );
      const fixtureTransport = wireTransport(
        Buffer.concat([head, fixture.wire]),
      );
      if (fixture.valid) {
        const response = await fixtureTransport.request();
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          new Uint8Array(fixture.decoded!),
        );
        expect(Number(response.headers.get("content-length"))).toBe(
          fixture.decoded!.byteLength,
        );
        if (fixture.encoding !== "identity")
          expect(response.headers.has("content-encoding")).toBe(false);
      } else {
        const code =
          fixture.error === "payload_too_large"
            ? "response_too_large"
            : fixture.encoding.includes(",")
              ? "unsupported_encoding"
              : "invalid_response";
        await expect(fixtureTransport.request()).rejects.toMatchObject({
          code,
          mayHaveDispatched: true,
        });
      }
      expect(fixtureTransport.closed()).toBe(1);
      expect(
        fixtureTransport.writes
          .map((part) => new TextDecoder().decode(part))
          .join(""),
      ).toContain("GET /fixture HTTP/1.1\r\n");
    });

  it("decodes finite chunking across every wire boundary without preserving routing headers", async () => {
    const fixture = wireTransport(
      Buffer.from(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\npu\r\n4\r\nblic\r\n0\r\n\r\n",
      ),
      1,
    );
    const response = await fixture.request();
    expect(await response.text()).toBe("public");
    expect(response.headers.has("transfer-encoding")).toBe(false);
    expect(response.headers.get("content-length")).toBe("6");
    expect(fixture.closed()).toBe(1);
  });
  for (const [name, frame] of [
    [
      "truncated declared body",
      "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\npublic",
    ],
    [
      "truncated chunk",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\npublic\r\n0\r\n\r\n",
    ],
    [
      "length and chunked ambiguity",
      "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n6\r\npublic\r\n0\r\n\r\n",
    ],
    [
      "conflicting content lengths",
      "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nContent-Length: 7\r\n\r\npublic",
    ],
    ["post-body bytes", "HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\npublicX"],
    [
      "unbounded transfer coding",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
    ],
  ] as const)
    it(`rejects ${name}`, async () => {
      const fixture = wireTransport(
        Buffer.from(frame),
        name === "post-body bytes" ? frame.length : 1,
      );
      await expect(fixture.request()).rejects.toMatchObject({
        code: "invalid_response",
        mayHaveDispatched: true,
      });
      expect(fixture.closed()).toBe(1);
    });
  it("enforces the decoded bound without depending on a declaration", async () => {
    const fixture = wireTransport(
      Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\npublic"),
      1,
    );
    await expect(fixture.request(5)).rejects.toMatchObject({
      code: "response_too_large",
      mayHaveDispatched: true,
    });
  });
  it("keeps trusted pre-connect faults distinct from ambiguous first physical write failure", async () => {
    const input = {
      url: "https://public.example.com/fixture",
      method: "GET",
      headers: new Headers(),
      signal: new AbortController().signal,
      maxResponseBytes: LIMITS.inlineBytes!,
    };
    const beforeConnect = createPinnedHttpTransport({
      async resolve() {
        throw new Error("Explicit DNS dependency fault");
      },
      async connect() {
        throw new Error("Unreachable connect after failed DNS");
      },
    });
    await expect(beforeConnect.request(input)).rejects.toMatchObject({
      mayHaveDispatched: false,
    });
    let writes = 0,
      closed = 0;
    const duringWrite = createPinnedHttpTransport({
      async resolve() {
        return ["8.8.8.8"];
      },
      async connect() {
        return {
          readable: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          writable: new WritableStream<Uint8Array>({
            write() {
              writes++;
              throw new Error("Explicit ambiguous physical write fault");
            },
          }),
          close() {
            closed++;
          },
        };
      },
    });
    await expect(duringWrite.request(input)).rejects.toMatchObject({
      mayHaveDispatched: true,
    });
    expect(writes).toBe(1);
    expect(closed).toBe(1);
  });
});
