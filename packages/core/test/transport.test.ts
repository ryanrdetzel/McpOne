import { deflate, deflateRaw, gzip } from "pako";
import { describe, expect, it, vi } from "vitest";
import {
  assertPublicAddress,
  createPinnedHttpTransport,
  type HttpTransportInput,
  type PinnedConnection,
  TransportError,
  validateTransportUrl,
} from "../src/integrations/transport";

const encode = new TextEncoder();
const decode = new TextDecoder();
const input = (
  overrides: Partial<HttpTransportInput> = {},
): HttpTransportInput => ({
  url: "https://api.example.com/resource?q=public",
  method: "GET",
  headers: new Headers(),
  signal: new AbortController().signal,
  maxResponseBytes: 4096,
  ...overrides,
});

function fixture(response: string | Uint8Array, addresses = ["93.184.215.14"]) {
  const writes: Uint8Array[] = [];
  const close = vi.fn();
  const bytes =
    typeof response === "string" ? encode.encode(response) : response;
  const resolve = vi.fn(async () => addresses);
  const connect = vi.fn(
    async (): Promise<PinnedConnection> => ({
      // One-byte segmentation exercises CRLF, headers and framing across reads.
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(chunk.slice());
        },
      }),
      close,
    }),
  );
  return {
    transport: createPinnedHttpTransport({ resolve, connect }),
    resolve,
    connect,
    writes,
    close,
  };
}

const forbiddenAddresses = [
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "255.255.255.255",
  "168.63.129.16",
  "::",
  "::1",
  "fc00::1",
  "fd00:ec2::254",
  "fe80::1",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:0808:0808",
  "64:ff9b::a00:1",
  "2001::1",
  "2001:db8::1",
  "2002:7f00:1::",
  "3fff::1",
  "4000::1",
  "127.1",
  "2130706433",
  "0x7f000001",
  "0177.0.0.1",
  "8.8.8.08",
  "fe80::1%eth0",
];

describe("connection-bound public destination policy", () => {
  for (const address of forbiddenAddresses) {
    it(`rejects ${address}`, () =>
      expect(() => assertPublicAddress(address)).toThrow(TransportError));
  }
  for (const address of [
    "8.8.8.8",
    "93.184.215.14",
    "140.82.114.5",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ]) {
    it(`accepts global address ${address}`, () =>
      expect(() => assertPublicAddress(address)).not.toThrow());
  }
  for (const url of [
    "https://127.1/",
    "https://2130706433/",
    "https://0x08080808/",
    "https://010.010.010.010/",
    "https://%38.8.8.8/",
    "https://[::ffff:8.8.8.8]/",
    "https://[fe80::1%25eth0]/",
    "https://localhost/",
    "https://host.local/",
    "https://host.internal/",
    "https://router.home.arpa/",
    "https://singlelabel/",
    "https://host.example./",
    "https://user:public@example.com/",
    "http://example.com/",
    "https://example.com\\@127.0.0.1/",
    "https://example.com/\r\npublic",
    "https://example.com/#fragment",
  ]) {
    it(`rejects nonportable or obfuscated URL ${url}`, () =>
      expect(() => validateTransportUrl(url)).toThrow(TransportError));
  }
  it("rejects any private DNS answer before opening a connection", async () => {
    const f = fixture("", ["93.184.215.14", "127.0.0.1"]);
    await expect(f.transport.request(input())).rejects.toMatchObject({
      code: "unsafe_target",
    });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("passes the vetted numeric address and original certificate hostname, never a second DNS lookup", async () => {
    const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    // If the hostname is resolved again it has rebound to a private address.
    f.resolve
      .mockResolvedValueOnce(["93.184.215.14"])
      .mockResolvedValue(["127.0.0.1"]);
    expect(await (await f.transport.request(input())).text()).toBe("ok");
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "93.184.215.14",
        hostname: "api.example.com",
        port: 443,
      }),
    );
    await expect(f.transport.request(input())).rejects.toMatchObject({
      code: "unsafe_target",
    });
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("validates literal IPv6 without consulting DNS", async () => {
    const f = fixture("HTTP/1.1 204 No Content\r\n\r\n");
    await f.transport.request(
      input({ url: "https://[2001:4860:4860::8888]/" }),
    );
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "2001:4860:4860::8888",
        hostname: "2001:4860:4860::8888",
      }),
    );
  });
});

describe("bounded HTTP1 transport", () => {
  it("returns a portable Response and only sends opaque credentials to the pinned target", async () => {
    const f = fixture(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}',
    );
    const response = await f.transport.request(
      input({
        method: "POST",
        headers: new Headers({
          authorization: "Bearer public-test-value",
          "x-provider-key": "public-test-value",
        }),
        body: encode.encode("public"),
      }),
    );
    expect(response).toBeInstanceOf(Response);
    expect(await response.json()).toEqual({ ok: true });
    const frame = f.writes.map((bytes) => decode.decode(bytes)).join("");
    expect(frame).toContain("POST /resource?q=public HTTP/1.1\r\n");
    expect(frame).toContain("authorization: Bearer public-test-value\r\n");
    expect(frame).toContain("x-provider-key: public-test-value\r\n");
    expect(frame).toContain("host: api.example.com\r\n");
    expect(frame).toContain("content-length: 6\r\n");
    expect(frame).toContain("connection: close\r\n");
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("never follows redirects or forwards credentials to a Location", async () => {
    const f = fixture(
      "HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n",
    );
    const response = await f.transport.request(
      input({
        headers: new Headers({ authorization: "Bearer public-test-value" }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://127.0.0.1/private");
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("decodes bounded chunked response framing and extensions", async () => {
    const f = fixture(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;public=yes\r\nok\r\n1\r\n!\r\n0\r\n\r\n",
    );
    const response = await f.transport.request(input());
    expect(await response.text()).toBe("ok!");
    expect(response.headers.has("transfer-encoding")).toBe(false);
  });
  it("supports bounded EOF-delimited responses", async () => {
    const f = fixture("HTTP/1.0 200 OK\r\n\r\npublic");
    expect(await (await f.transport.request(input())).text()).toBe("public");
  });
  it("supports bounded interim responses", async () => {
    const f = fixture(
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    );
    expect(await (await f.transport.request(input())).text()).toBe("ok");
  });
  for (const response of [
    "HTTP/1.1 200 OK\nContent-Length: 0\n\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nok",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nok",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: +2\r\n\r\nok",
    "HTTP/1.1 200 OK\r\nContent-Length: 2, 2\r\n\r\nok",
    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok",
    "HTTP/1.1 200 OK\r\n Folded: forbidden\r\n\r\n",
    "HTTP/1.1 200 OK\r\nX-Public: public\r\r\n\r\n",
    "HTTP/1.1 101 Switching Protocols\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ng\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nokX\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nAuthorization: public\r\n\r\n",
  ]) {
    it(`rejects ambiguous/truncated framing ${JSON.stringify(response)}`, async () => {
      const f = fixture(response);
      await expect(f.transport.request(input())).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(f.close).toHaveBeenCalledTimes(1);
    });
  }
  for (const response of [
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nlarge",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nlarge\r\n0\r\n\r\n",
    "HTTP/1.0 200 OK\r\n\r\nlarge",
  ]) {
    it("enforces the response cap before returning a body", async () => {
      const f = fixture(response);
      await expect(
        f.transport.request(input({ maxResponseBytes: 4 })),
      ).rejects.toMatchObject({ code: "response_too_large" });
    });
  }
  it("rejects excessive response headers", async () => {
    const f = fixture(
      `HTTP/1.1 200 OK\r\nX-Large: ${"a".repeat(8193)}\r\n\r\n`,
    );
    await expect(f.transport.request(input())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  for (const name of [
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "expect",
    "proxy-authorization",
  ]) {
    it(`rejects caller-controlled framing header ${name}`, async () => {
      const f = fixture("");
      await expect(
        f.transport.request(
          input({ headers: new Headers({ [name]: "public" }) }),
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.connect).not.toHaveBeenCalled();
    });
  }
  it("rejects unsupported or stacked media encodings", async () => {
    for (const encoding of ["br", "gzip, deflate", "identity, gzip"]) {
      const f = fixture(
        `HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: 2\r\n\r\nok`,
      );
      await expect(f.transport.request(input())).rejects.toMatchObject({
        code: "unsupported_encoding",
      });
    }
  });
  it("rejects compressed upload claims outside the identity-only request contract", async () => {
    const f = fixture("");
    await expect(
      f.transport.request(
        input({
          method: "POST",
          body: encode.encode("public"),
          headers: new Headers({ "content-encoding": "gzip" }),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("sanitizes platform failures without exposing credential headers", async () => {
    const f = fixture("");
    f.connect.mockRejectedValue(
      new Error("Bearer public-test-value upstream-debug-data"),
    );
    await expect(
      f.transport.request(
        input({
          headers: new Headers({ authorization: "Bearer public-test-value" }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "connection_failure",
      message: "HTTP transport: connection_failure",
    });
  });
});

describe("bounded lifetime and cancellation", () => {
  it("rejects cancellation before DNS or connection", async () => {
    const f = fixture("");
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.transport.request(input({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("bounds unresolved DNS time", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<string[]>();
      const connect = vi.fn();
      const transport = createPinnedHttpTransport(
        { resolve: () => pending.promise, connect },
        { timeoutMs: 5 },
      );
      const assertion = expect(
        transport.request(input()),
      ).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      expect(connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("closes stalled sockets when the response deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      const connection = {
        readable: new ReadableStream<Uint8Array>(),
        writable: new WritableStream<Uint8Array>(),
        close,
      };
      const transport = createPinnedHttpTransport(
        {
          resolve: async () => ["93.184.215.14"],
          connect: async () => connection,
        },
        { timeoutMs: 5 },
      );
      const assertion = expect(
        transport.request(input()),
      ).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("closes sockets on caller cancellation during body read", async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const connection = {
      readable: new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            encode.encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n"),
          );
        },
        pull() {
          controller.abort();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close,
    };
    const transport = createPinnedHttpTransport({
      resolve: async () => ["93.184.215.14"],
      connect: async () => connection,
    });
    await expect(
      transport.request(input({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("D12 exact byte and deadline boundaries", () => {
  it("accepts the exact 27,328,512-byte body ceiling independently from HTTP framing", async () => {
    let bodyBytes = 0;
    let frameBytes = 0;
    const connect = vi.fn(async () => ({
      readable: new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(encode.encode("HTTP/1.1 204 No Content\r\n\r\n"));
          stream.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          if (decode.decode(chunk.subarray(0, 5)) === "POST ")
            frameBytes += chunk.byteLength;
          else bodyBytes += chunk.byteLength;
        },
      }),
      close() {},
    }));
    const transport = createPinnedHttpTransport({
      resolve: async () => ["93.184.215.14"],
      connect,
    });
    await transport.request(
      input({ method: "POST", body: new Uint8Array(27_328_512) }),
    );
    expect(bodyBytes).toBe(27_328_512);
    expect(frameBytes).toBeGreaterThan(0);
    expect(frameBytes).toBeLessThan(16 * 1024 + 8 * 1024);
    const connects = connect.mock.calls.length;
    await expect(
      transport.request(
        input({ method: "POST", body: new Uint8Array(27_328_512 + 1) }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      mayHaveDispatched: false,
    });
    expect(connect).toHaveBeenCalledTimes(connects);
  });
  it("accepts the 25MiB response boundary and rejects one byte beyond it", async () => {
    const max = 25 * 1024 * 1024;
    let declared = max;
    const transport = createPinnedHttpTransport({
      resolve: async () => ["93.184.215.14"],
      connect: async () => ({
        readable: new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(
              encode.encode(
                `HTTP/1.1 200 OK\r\nContent-Length: ${declared}\r\n\r\n`,
              ),
            );
            stream.enqueue(new Uint8Array(max));
            stream.close();
          },
        }),
        writable: new WritableStream<Uint8Array>(),
        close() {},
      }),
    });
    expect(
      (
        await (
          await transport.request(input({ maxResponseBytes: max }))
        ).arrayBuffer()
      ).byteLength,
    ).toBe(max);
    declared = max + 1;
    await expect(
      transport.request(input({ maxResponseBytes: max })),
    ).rejects.toMatchObject({ code: "response_too_large" });
    await expect(
      transport.request(input({ maxResponseBytes: max + 1 })),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("does not silently shorten a Run signal to a 30-second transport timeout", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = Promise.withResolvers<string[]>();
      const transport = createPinnedHttpTransport({
        resolve: () => pending.promise,
        connect: vi.fn(),
      });
      let settled = false;
      const result = transport.request(input({ signal: controller.signal }));
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      controller.abort();
      await expect(result).rejects.toMatchObject({ code: "aborted" });
      expect(() =>
        createPinnedHttpTransport(
          { resolve: vi.fn(), connect: vi.fn() },
          { timeoutMs: 300_000 },
        ),
      ).not.toThrow();
      expect(() =>
        createPinnedHttpTransport(
          { resolve: vi.fn(), connect: vi.fn() },
          { timeoutMs: 300_001 },
        ),
      ).toThrow(TransportError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reserved protocol service destinations", () => {
  for (const address of [
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "2620:4f:8000::1",
  ]) {
    it(`rejects reserved service ${address}`, () =>
      expect(() => assertPublicAddress(address)).toThrow(TransportError));
  }
});

describe("strict bounded compressed response decoding", () => {
  function compressedFixture(bytes: Uint8Array, encoding: string) {
    const header = encode.encode(
      `HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: ${bytes.byteLength}\r\n\r\n`,
    );
    const response = new Uint8Array(header.byteLength + bytes.byteLength);
    response.set(header);
    response.set(bytes, header.byteLength);
    return fixture(response);
  }
  for (const encoding of ["gzip", "deflate"] as const) {
    const compress = encoding === "gzip" ? gzip : deflate;
    it(`decodes ${encoding} and reports only decoded headers/length`, async () => {
      const text = "public-response".repeat(100);
      const bytes = compress(encode.encode(text));
      const f = compressedFixture(bytes, encoding);
      const response = await f.transport.request(input());
      expect(await response.text()).toBe(text);
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.get("content-length")).toBe(
        String(encode.encode(text).byteLength),
      );
      expect(f.writes.map((part) => decode.decode(part)).join("")).toContain(
        "accept-encoding: identity\r\n",
      );
    });
    it(`bounds decoded ${encoding} independently from compressed bytes`, async () => {
      const f = compressedFixture(
        compress(encode.encode("public".repeat(100))),
        encoding,
      );
      await expect(
        f.transport.request(input({ maxResponseBytes: 100 })),
      ).rejects.toMatchObject({ code: "response_too_large" });
    });
    it(`enforces exact decoded ${encoding} boundary and boundary+1`, async () => {
      const text = encode.encode("public".repeat(100));
      const f = compressedFixture(compress(text), encoding);
      expect(
        (
          await (
            await f.transport.request(
              input({ maxResponseBytes: text.byteLength }),
            )
          ).arrayBuffer()
        ).byteLength,
      ).toBe(text.byteLength);
      await expect(
        f.transport.request(input({ maxResponseBytes: text.byteLength - 1 })),
      ).rejects.toMatchObject({ code: "response_too_large" });
    });
    const invalidTails = [new Uint8Array([0]), new Uint8Array([1])];
    if (encoding === "deflate")
      invalidTails.push(compress(encode.encode("second-stream")));
    for (const trailing of invalidTails) {
      it(`rejects ${encoding} malformed trailing bytes and zero padding`, async () => {
        const first = compress(encode.encode("public"));
        const bytes = new Uint8Array(first.byteLength + trailing.byteLength);
        bytes.set(first);
        bytes.set(trailing, first.byteLength);
        await expect(
          compressedFixture(bytes, encoding).transport.request(input()),
        ).rejects.toMatchObject({ code: "invalid_response" });
      });
    }
    it(`rejects truncated and checksum-invalid ${encoding}`, async () => {
      const bytes = compress(encode.encode("public"));
      await expect(
        compressedFixture(
          bytes.subarray(0, bytes.byteLength - 1),
          encoding,
        ).transport.request(input()),
      ).rejects.toMatchObject({ code: "invalid_response" });
      const damaged = bytes.slice();
      damaged[damaged.byteLength - 1] = damaged[damaged.byteLength - 1]! ^ 0xff;
      await expect(
        compressedFixture(damaged, encoding).transport.request(input()),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
    it(`bounds compressed ${encoding} bytes before decoding`, async () => {
      const bytes = compress(encode.encode("public"));
      await expect(
        compressedFixture(bytes, encoding).transport.request(
          input({ maxResponseBytes: bytes.byteLength - 1 }),
        ),
      ).rejects.toMatchObject({ code: "response_too_large" });
    });
  }
  it("rejects raw deflate and mismatched gzip/zlib wrappers", async () => {
    const text = encode.encode("public");
    await expect(
      compressedFixture(deflateRaw(text), "deflate").transport.request(input()),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      compressedFixture(gzip(text), "deflate").transport.request(input()),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      compressedFixture(deflate(text), "gzip").transport.request(input()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects zlib preset dictionaries rather than guessing one", async () => {
    const text = encode.encode("public");
    const bytes = deflate(text, {
      dictionary: encode.encode("public-dictionary"),
    });
    await expect(
      compressedFixture(bytes, "deflate").transport.request(input()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("honors cancellation during decompression rather than only during I/O", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const text = encode.encode("public".repeat(100_000));
    const f = compressedFixture(gzip(text), "gzip");
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      const assertion = expect(
        f.transport.request(
          input({
            signal: controller.signal,
            maxResponseBytes: text.byteLength,
          }),
        ),
      ).rejects.toMatchObject({ code: "aborted" });
      await vi.advanceTimersByTimeAsync(0);
      await assertion;
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
      vi.useRealTimers();
    }
  });
  it("decodes all valid concatenated gzip members under one aggregate cap", async () => {
    const members = [
      gzip(encode.encode("public".repeat(100))),
      gzip(new Uint8Array()),
      gzip(encode.encode("response".repeat(100))),
    ];
    const bytes = new Uint8Array(
      members.reduce((length, member) => length + member.byteLength, 0),
    );
    let offset = 0;
    for (const member of members) {
      bytes.set(member, offset);
      offset += member.byteLength;
    }
    const f = compressedFixture(bytes, "gzip");
    const text = "public".repeat(100) + "response".repeat(100);
    expect(
      await (
        await f.transport.request(input({ maxResponseBytes: text.length }))
      ).text(),
    ).toBe(text);
    await expect(
      f.transport.request(input({ maxResponseBytes: text.length - 1 })),
    ).rejects.toMatchObject({ code: "response_too_large" });
    bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 0xff;
    await expect(
      compressedFixture(bytes, "gzip").transport.request(input()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("yields for cancellation during long empty-member chains without imposing a member-count cap", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const empty = gzip(new Uint8Array());
    const bytes = new Uint8Array(empty.byteLength * 1000);
    for (let index = 0; index < 1000; index++)
      bytes.set(empty, index * empty.byteLength);
    const f = compressedFixture(bytes, "gzip");
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      const assertion = expect(
        f.transport.request(
          input({
            signal: controller.signal,
            maxResponseBytes: bytes.byteLength,
          }),
        ),
      ).rejects.toMatchObject({ code: "aborted" });
      await vi.advanceTimersByTimeAsync(0);
      await assertion;
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
      vi.useRealTimers();
    }
  });
  it("accepts a bounded long chain of valid empty members without a count limit", async () => {
    vi.useFakeTimers();
    try {
      const empty = gzip(new Uint8Array());
      const bytes = new Uint8Array(empty.byteLength * 1000);
      for (let index = 0; index < 1000; index++)
        bytes.set(empty, index * empty.byteLength);
      const result = compressedFixture(bytes, "gzip").transport.request(
        input({ maxResponseBytes: bytes.byteLength }),
      );
      const assertion = expect(
        result.then((response) => response.text()),
      ).resolves.toBe("");
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("trusted dispatch certainty", () => {
  it("defaults TransportError to verified pre-dispatch provenance", () => {
    expect(new TransportError("connection_failure").mayHaveDispatched).toBe(
      false,
    );
  });
  it("keeps input and DNS rejection pre-dispatch", async () => {
    const f = fixture("");
    await expect(
      f.transport.request(input({ url: "https://127.0.0.1/" })),
    ).rejects.toMatchObject({
      code: "unsafe_target",
      mayHaveDispatched: false,
    });
    f.resolve.mockRejectedValue(new TransportError("dns_failure"));
    await expect(f.transport.request(input())).rejects.toMatchObject({
      code: "dns_failure",
      mayHaveDispatched: false,
    });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("keeps TLS establishment failure pre-dispatch and preserves trusted prior ambiguity", async () => {
    const f = fixture("");
    f.connect.mockRejectedValueOnce(new TransportError("connection_failure"));
    await expect(f.transport.request(input())).rejects.toMatchObject({
      code: "connection_failure",
      mayHaveDispatched: false,
    });
    f.connect.mockRejectedValueOnce(
      new TransportError("connection_failure", true),
    );
    await expect(f.transport.request(input())).rejects.toMatchObject({
      code: "connection_failure",
      mayHaveDispatched: true,
    });
  });
  it("treats rejected first writes as possibly dispatched, without trusting zero-byte counters", async () => {
    const close = vi.fn();
    const transport = createPinnedHttpTransport({
      resolve: async () => ["93.184.215.14"],
      connect: async () => ({
        readable: new ReadableStream<Uint8Array>(),
        writable: new WritableStream<Uint8Array>({
          write() {
            throw new TransportError("connection_failure");
          },
        }),
        close,
      }),
    });
    await expect(transport.request(input())).rejects.toMatchObject({
      code: "connection_failure",
      mayHaveDispatched: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("treats body-write failures as possibly dispatched", async () => {
    let writes = 0;
    const transport = createPinnedHttpTransport({
      resolve: async () => ["93.184.215.14"],
      connect: async () => ({
        readable: new ReadableStream<Uint8Array>(),
        writable: new WritableStream<Uint8Array>({
          write() {
            if (++writes === 2) throw new Error("public fixture failure");
          },
        }),
        close() {},
      }),
    });
    await expect(
      transport.request(
        input({ method: "POST", body: encode.encode("public") }),
      ),
    ).rejects.toMatchObject({
      code: "connection_failure",
      mayHaveDispatched: true,
      message: "HTTP transport: connection_failure",
    });
    expect(writes).toBe(2);
  });
  it("keeps response framing and size failures possibly dispatched", async () => {
    await expect(
      fixture(
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nok",
      ).transport.request(input()),
    ).rejects.toMatchObject({
      code: "invalid_response",
      mayHaveDispatched: true,
    });
    await expect(
      fixture(
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nlarge",
      ).transport.request(input({ maxResponseBytes: 4 })),
    ).rejects.toMatchObject({
      code: "response_too_large",
      mayHaveDispatched: true,
    });
  });
  it("keeps decompression failures possibly dispatched", async () => {
    const body = gzip(encode.encode("public"));
    body[body.byteLength - 1] = body[body.byteLength - 1]! ^ 0xff;
    const header = encode.encode(
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.byteLength}\r\n\r\n`,
    );
    const bytes = new Uint8Array(header.byteLength + body.byteLength);
    bytes.set(header);
    bytes.set(body, header.byteLength);
    await expect(
      fixture(bytes).transport.request(input()),
    ).rejects.toMatchObject({
      code: "invalid_response",
      mayHaveDispatched: true,
    });
  });
  it("distinguishes stalled pre-connection and post-write deadline provenance", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<PinnedConnection>();
      const pre = createPinnedHttpTransport(
        {
          resolve: async () => ["93.184.215.14"],
          connect: () => pending.promise,
        },
        { timeoutMs: 5 },
      );
      const post = createPinnedHttpTransport(
        {
          resolve: async () => ["93.184.215.14"],
          connect: async () => ({
            readable: new ReadableStream<Uint8Array>(),
            writable: new WritableStream<Uint8Array>(),
            close() {},
          }),
        },
        { timeoutMs: 5 },
      );
      const preAssertion = expect(pre.request(input())).rejects.toMatchObject({
        code: "timeout",
        mayHaveDispatched: false,
      });
      const postAssertion = expect(post.request(input())).rejects.toMatchObject(
        { code: "timeout", mayHaveDispatched: true },
      );
      await vi.advanceTimersByTimeAsync(5);
      await Promise.all([preAssertion, postAssertion]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects independently oversized request headers before dispatch", async () => {
    const f = fixture("");
    await expect(
      f.transport.request(
        input({ headers: new Headers({ "x-public": "a".repeat(16 * 1024) }) }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      mayHaveDispatched: false,
    });
    expect(f.connect).not.toHaveBeenCalled();
  });
});
