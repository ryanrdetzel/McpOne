import { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalHttpTransport } from "../src/transport";

const state = vi.hoisted(() => ({
  ipv4: ["93.184.215.14"],
  ipv6: [] as string[],
  remoteAddress: "93.184.215.14",
  authorized: true,
  connect: vi.fn(),
  checkServerIdentity: vi.fn(),
  cancel: vi.fn(),
  writes: [] as string[],
  destroyed: false,
  tlsErrorCode: undefined as string | undefined,
  synchronousError: false,
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolve4() {
      return Promise.resolve(state.ipv4);
    }
    resolve6() {
      return Promise.resolve(state.ipv6);
    }
    cancel() {
      state.cancel();
    }
  },
}));

vi.mock("node:tls", () => {
  return {
    checkServerIdentity: state.checkServerIdentity,
    connect(options: Record<string, unknown>) {
      state.connect(options);
      if (state.synchronousError)
        throw new Error("public fixture synchronous TLS policy denial");
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          state.writes.push(chunk.toString());
          socket.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
          socket.push(null);
          callback();
        },
        destroy(error, callback) {
          state.destroyed = true;
          callback(error);
        },
      });
      Object.assign(socket, {
        authorized: state.authorized,
        remoteAddress: state.remoteAddress,
        alpnProtocol: "http/1.1",
      });
      queueMicrotask(() => {
        if (state.tlsErrorCode)
          socket.emit(
            "error",
            Object.assign(new Error("public fixture TLS failure"), {
              code: state.tlsErrorCode,
            }),
          );
        else socket.emit("secureConnect");
      });
      return socket;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  state.ipv4 = ["93.184.215.14"];
  state.ipv6 = [];
  state.remoteAddress = "93.184.215.14";
  state.authorized = true;
  state.writes = [];
  state.destroyed = false;
  state.tlsErrorCode = undefined;
  state.synchronousError = false;
});

const request = () => ({
  url: "https://api.example.com/public",
  method: "GET",
  headers: new Headers({ authorization: "Bearer public-test-value" }),
  signal: new AbortController().signal,
  maxResponseBytes: 1024,
});

describe("Node connection and certificate pinning", () => {
  it("rejects a mismatched connected peer before writing credentials", async () => {
    state.remoteAddress = "127.0.0.1";
    await expect(
      createLocalHttpTransport().request(request()),
    ).rejects.toMatchObject({
      code: "unsafe_target",
      mayHaveDispatched: false,
    });
    expect(state.writes).toEqual([]);
    expect(state.destroyed).toBe(true);
  });
  it("rejects failed certificate authorization before writing credentials", async () => {
    state.authorized = false;
    await expect(
      createLocalHttpTransport().request(request()),
    ).rejects.toMatchObject({
      code: "tls_validation_failed",
      mayHaveDispatched: false,
    });
    expect(state.writes).toEqual([]);
    expect(state.destroyed).toBe(true);
  });
  it("validates all DNS families and rejects a rebinding private answer before dialing", async () => {
    state.ipv6 = ["::1"];
    await expect(
      createLocalHttpTransport().request(request()),
    ).rejects.toMatchObject({ code: "unsafe_target" });
    expect(state.connect).not.toHaveBeenCalled();
    expect(state.cancel).toHaveBeenCalled();
  });
  it("revalidates fresh DNS for each connection rather than reusing hostname sockets", async () => {
    const transport = createLocalHttpTransport();
    await transport.request(request());
    state.ipv4 = ["127.0.0.1"];
    await expect(transport.request(request())).rejects.toMatchObject({
      code: "unsafe_target",
    });
    expect(state.connect).toHaveBeenCalledTimes(1);
  });
});

describe("permanent TLS validation failures versus transient network dialing", () => {
  for (const code of [
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_SSL_CA_MD_TOO_WEAK",
    "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
    "UNKNOWN_TLS_POLICY_DENIAL",
  ]) {
    it(`classifies ${code} as permanent before credentials are written`, async () => {
      state.tlsErrorCode = code;
      await expect(
        createLocalHttpTransport().request(request()),
      ).rejects.toMatchObject({
        code: "tls_validation_failed",
        mayHaveDispatched: false,
      });
      expect(state.writes).toEqual([]);
      expect(state.destroyed).toBe(true);
    });
  }
  for (const code of [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
  ]) {
    it(`preserves transient ${code} as a pre-dispatch connection failure`, async () => {
      state.tlsErrorCode = code;
      await expect(
        createLocalHttpTransport().request(request()),
      ).rejects.toMatchObject({
        code: "connection_failure",
        mayHaveDispatched: false,
      });
      expect(state.writes).toEqual([]);
    });
  }
  it("classifies synchronous TLS option/policy denial as permanent", async () => {
    state.synchronousError = true;
    await expect(
      createLocalHttpTransport().request(request()),
    ).rejects.toMatchObject({
      code: "tls_validation_failed",
      mayHaveDispatched: false,
    });
    expect(state.writes).toEqual([]);
  });
});
