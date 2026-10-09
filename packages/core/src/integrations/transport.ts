/// <reference lib="es2024.promise" />

import { hasCodeUnitInRange } from "@scaffold/schema/integrations";
import {
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  ZStream,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
  zlibInflateReset,
} from "pako";

export interface HttpTransportInput {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal: AbortSignal;
  maxResponseBytes: number;
}

export interface HttpTransport {
  request(input: HttpTransportInput): Promise<Response>;
}

export type TransportErrorCode =
  | "invalid_request"
  | "unsafe_target"
  | "dns_failure"
  | "connection_failure"
  | "unsupported_destination"
  | "invalid_response"
  | "response_too_large"
  | "timeout"
  | "aborted"
  | "unsupported_encoding"
  | "tls_validation_failed";

// Errors never interpolate URLs, headers, bodies, DNS data or platform error messages.
export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    readonly mayHaveDispatched: boolean = false,
  ) {
    super(`HTTP transport: ${code}`);
    this.name = "TransportError";
  }
}

export interface PinnedConnection {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

export interface PinnedTransportPlatform {
  resolve(hostname: string, signal: AbortSignal): Promise<string[]>;
  // Must connect to this exact numeric address, verify the certificate against
  // hostname, and send no application bytes before TLS authentication succeeds.
  connect(input: {
    address: string;
    hostname: string;
    port: number;
    signal: AbortSignal;
  }): Promise<PinnedConnection>;
}

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_BYTES = 27_328_512;
const MAX_HEADERS = 32 * 1024;
const MAX_REQUEST_HEADERS = 16 * 1024;
const MAX_LINE = 8 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const encoder = new TextEncoder();

function fail(code: TransportErrorCode): never {
  throw new TransportError(code);
}

// Only canonical dotted-decimal IPv4 and unscoped IPv6 are accepted. In
// particular mapped/compatible IPv6, integer/octal/hex IPv4 and zone IDs fail.
export function parseAddress(
  address: string,
): { value: bigint; bits: 32 | 128 } | null {
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    const octets = address.split(".").map(Number);
    if (octets.some((n) => n > 255)) return null;
    return {
      value: octets.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n),
      bits: 32,
    };
  }
  if (!address.includes(":") || !/^[0-9a-f:]+$/i.test(address)) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part)))
    return null;
  if (halves.length === 1 ? left.length !== 8 : left.length + right.length >= 8)
    return null;
  const groups =
    halves.length === 1
      ? left
      : [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill("0"),
          ...right,
        ];
  return {
    value: groups.reduce(
      (n, group) => (n << 16n) | BigInt(parseInt(group, 16)),
      0n,
    ),
    bits: 128,
  };
}

export function addressInCidr(address: string, cidr: string): boolean {
  const parsed = parseAddress(address);
  const [base, prefixText] = cidr.split("/");
  const network = parseAddress(base!);
  const prefix = Number(prefixText);
  if (
    !parsed ||
    !network ||
    parsed.bits !== network.bits ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > parsed.bits
  )
    return false;
  const shift = BigInt(parsed.bits - prefix);
  return parsed.value >> shift === network.value >> shift;
}

// Exclude IANA special-purpose reservations, even those with globally routable
// protocol-specific exceptions; this adapter targets ordinary public HTTPS.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "168.63.129.16/32",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.175.48.0/24",
];

export function assertPublicAddress(address: string): void {
  const parsed = parseAddress(address);
  if (!parsed) fail("unsafe_target");
  if (parsed.bits === 32) {
    if (BLOCKED_V4.some((cidr) => addressInCidr(address, cidr)))
      fail("unsafe_target");
  } else {
    // Positive global-unicast allocation, excluding special-purpose protocols,
    // documentation, Teredo, 6to4 and all embedded IPv4 transition formats.
    if (
      !addressInCidr(address, "2000::/3") ||
      [
        "2001::/23",
        "2001:db8::/32",
        "2002::/16",
        "2620:4f:8000::/48",
        "3fff::/20",
      ].some((cidr) => addressInCidr(address, cidr))
    )
      fail("unsafe_target");
  }
}

export function validateTransportUrl(input: string): {
  url: URL;
  hostname: string;
  literal: boolean;
} {
  if (
    input.length > MAX_LINE ||
    hasCodeUnitInRange(input, 0, 32) ||
    input.includes("\x7f") ||
    input.includes("\\")
  )
    fail("invalid_request");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    fail("invalid_request");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    fail("invalid_request");
  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (!authority || authority.includes("%") || authority.includes("@"))
    fail("unsafe_target");
  const rawHost = authority.startsWith("[")
    ? /^\[([^\]]+)\](?::[0-9]+)?$/.exec(authority)?.[1]
    : /^([^:]+)(?::[0-9]+)?$/.exec(authority)?.[1];
  if (!rawHost) fail("unsafe_target");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = parseAddress(hostname) !== null;
  if (literal) {
    if (!parseAddress(rawHost)) fail("unsafe_target");
    assertPublicAddress(hostname);
  } else {
    if (
      rawHost.toLowerCase() !== hostname ||
      hostname.length > 253 ||
      !hostname.includes(".") ||
      hostname.endsWith(".") ||
      hostname
        .split(".")
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      fail("unsafe_target");
    if (
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(hostname) ||
      hostname.endsWith(".home.arpa")
    )
      fail("unsafe_target");
  }
  return { url, hostname, literal };
}

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new TransportError("aborted"));
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const aborted = () => reject(new TransportError("aborted"));
  signal.addEventListener("abort", aborted, { once: true });
  promise
    .then(resolve, reject)
    .finally(() => signal.removeEventListener("abort", aborted));
  return result;
}

// Also used for the fixed trusted DNS bootstrap, never for arbitrary targets.
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const output = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) return output.slice(0, length);
      if (value.byteLength > limit - length) fail("response_too_large");
      output.set(value, length);
      length += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class WireReader {
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;
  private received = 0;
  constructor(
    private reader: ReadableStreamDefaultReader<Uint8Array>,
    private signal: AbortSignal,
    private limit: number,
  ) {}
  get buffered(): number {
    return this.chunk.byteLength - this.offset;
  }
  async next(): Promise<boolean> {
    if (this.buffered) return true;
    for (let emptyChunks = 0; emptyChunks < 8; emptyChunks++) {
      const result = await abortable(this.reader.read(), this.signal);
      if (result.done) return false;
      this.received += result.value.byteLength;
      if (this.received > this.limit) fail("response_too_large");
      this.chunk = result.value;
      this.offset = 0;
      if (this.buffered) return true;
    }
    fail("invalid_response");
  }
  async line(limit = MAX_LINE): Promise<string> {
    const bytes: number[] = [];
    while (true) {
      if (!(await this.next())) fail("invalid_response");
      const byte = this.chunk[this.offset++]!;
      if (byte === 10) {
        if (bytes.pop() !== 13) fail("invalid_response");
        return String.fromCharCode(...bytes);
      }
      if (bytes.length >= limit + 1 || byte === 0) fail("invalid_response");
      bytes.push(byte);
    }
  }
  async copy(
    output: Uint8Array,
    offset: number,
    length: number,
  ): Promise<void> {
    while (length) {
      if (!(await this.next())) fail("invalid_response");
      const count = Math.min(length, this.buffered);
      output.set(this.chunk.subarray(this.offset, this.offset + count), offset);
      this.offset += count;
      offset += count;
      length -= count;
    }
  }
  async remainder(output: Uint8Array): Promise<number> {
    let length = 0;
    while (await this.next()) {
      const count = this.buffered;
      if (count > output.byteLength - length) fail("response_too_large");
      await this.copy(output, length, count);
      length += count;
    }
    return length;
  }
}

async function decodeContent(
  bytes: Uint8Array,
  encoding: "gzip" | "deflate",
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  // Public low-level pako API verifies every complete gzip member. Explicit
  // member transitions preserve aggregate caps and reject malformed/zero tails;
  // zlib-wrapped deflate permits exactly one stream, never concatenation.
  const stream = new ZStream();
  if (zlibInflateInit2(stream, encoding === "gzip" ? 31 : 15) !== Z_OK)
    fail("invalid_response");
  const output = new Uint8Array(max);
  const slab = new Uint8Array(16 * 1024);
  let decodedLength = 0;
  let inputOffset = 0;
  let workBytes = 0;
  let workCalls = 0;
  stream.input = bytes.subarray(0, 64 * 1024);
  stream.avail_in = stream.input.byteLength;
  try {
    while (true) {
      if (signal.aborted) fail("aborted");
      stream.output = slab;
      stream.next_out = 0;
      stream.avail_out = slab.byteLength;
      const beforeInput = stream.next_in;
      const status = zlibInflate(stream, Z_NO_FLUSH);
      if (status !== Z_OK && status !== Z_STREAM_END) fail("invalid_response");
      if (stream.next_out > max - decodedLength) fail("response_too_large");
      output.set(slab.subarray(0, stream.next_out), decodedLength);
      decodedLength += stream.next_out;
      const consumed = stream.next_in - beforeInput;
      workBytes += consumed + stream.next_out;
      workCalls++;
      if (status === Z_STREAM_END) {
        if (
          inputOffset + stream.next_in === bytes.byteLength &&
          stream.avail_in === 0
        )
          return output.subarray(0, decodedLength);
        if (encoding !== "gzip" || zlibInflateReset(stream) !== Z_OK)
          fail("invalid_response");
      }
      if (consumed === 0 && stream.next_out === 0) fail("invalid_response");
      if (
        stream.avail_in === 0 &&
        inputOffset + stream.input.byteLength < bytes.byteLength
      ) {
        inputOffset += stream.input.byteLength;
        stream.input = bytes.subarray(inputOffset, inputOffset + 64 * 1024);
        stream.next_in = 0;
        stream.avail_in = stream.input.byteLength;
      }
      // Bound each synchronous slice and let caller deadlines/cancellation run
      // during large responses AND long chains of valid empty gzip members.
      if (workBytes >= 256 * 1024 || workCalls >= 64) {
        workBytes = 0;
        workCalls = 0;
        const pause = Promise.withResolvers<void>();
        const timer = setTimeout(pause.resolve, 0);
        try {
          await abortable(pause.promise, signal);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  } catch (error) {
    if (error instanceof TransportError) throw error;
    fail("invalid_response");
  } finally {
    zlibInflateEnd(stream);
  }
}

async function readResponse(
  connection: PinnedConnection,
  method: string,
  max: number,
  signal: AbortSignal,
): Promise<Response> {
  const reader = connection.readable.getReader();
  const wire = new WireReader(reader, signal, max + 96 * 1024);
  try {
    let status = 0;
    let headers = new Headers();
    let headerBytes = 0;
    let hasLength = false;
    let hasTransfer = false;
    for (let interim = 0; ; interim++) {
      if (interim > 4) fail("invalid_response");
      const statusLine = await wire.line();
      headerBytes += statusLine.length + 2;
      const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(
        statusLine,
      );
      if (!match) fail("invalid_response");
      status = Number(match[1]);
      headers = new Headers();
      hasLength = false;
      hasTransfer = false;
      let count = 0;
      while (true) {
        const line = await wire.line();
        headerBytes += line.length + 2;
        if (headerBytes > MAX_HEADERS || ++count > 100)
          fail("invalid_response");
        if (!line) break;
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (
          colon < 1 ||
          !TOKEN.test(name) ||
          hasCodeUnitInRange(line, 0, 8) ||
          hasCodeUnitInRange(line, 10, 31) ||
          line.includes("\x7f")
        )
          fail("invalid_response");
        if (name === "content-length") {
          if (hasLength) fail("invalid_response");
          hasLength = true;
        }
        if (name === "transfer-encoding") {
          if (hasTransfer) fail("invalid_response");
          hasTransfer = true;
        }
        headers.append(name, value);
      }
      if (hasLength && hasTransfer) fail("invalid_response");
      if (status >= 200) break;
      if (status === 101 || hasTransfer || hasLength) fail("invalid_response");
    }
    const transfer = headers.get("transfer-encoding");
    if (transfer !== null && transfer.toLowerCase() !== "chunked")
      fail("invalid_response");
    const lengthText = headers.get("content-length");
    if (lengthText !== null && !/^(?:0|[1-9][0-9]*)$/.test(lengthText))
      fail("invalid_response");
    const declared = lengthText === null ? null : Number(lengthText);
    if (
      declared !== null &&
      (!Number.isSafeInteger(declared) || declared > max)
    )
      fail("response_too_large");
    const bodyless =
      method === "HEAD" || status === 204 || status === 205 || status === 304;
    if (
      (status === 204 || status === 205) &&
      (transfer || (declared !== null && declared !== 0))
    )
      fail("invalid_response");
    const body = new Uint8Array(bodyless ? 0 : (declared ?? max));
    let length = 0;
    if (!bodyless && transfer) {
      let framingBytes = 0;
      for (let chunks = 0; ; chunks++) {
        if (chunks > 16_384) fail("invalid_response");
        const line = await wire.line(1024);
        framingBytes += line.length + 2;
        // Extensions are bounded and ignored, never interpreted as headers.
        if (!/^[0-9a-fA-F]+(?:;[\x20-\x7e]*)?$/.test(line))
          fail("invalid_response");
        const size = parseInt(line.split(";")[0]!, 16);
        if (!Number.isSafeInteger(size) || size > max - length)
          fail("response_too_large");
        if (size === 0) {
          // No trailers are needed by the contract; accepting only the empty
          // trailer section avoids hidden framing/authentication mutations.
          if ((await wire.line()) !== "") fail("invalid_response");
          break;
        }
        await wire.copy(body, length, size);
        length += size;
        if ((await wire.line(0)) !== "") fail("invalid_response");
        framingBytes += 2;
        if (framingBytes > 64 * 1024) fail("invalid_response");
      }
    } else if (!bodyless && declared !== null) {
      await wire.copy(body, 0, declared);
      length = declared;
    } else if (!bodyless) {
      length = await wire.remainder(body);
    }
    if (wire.buffered) fail("invalid_response");
    headers.delete("transfer-encoding");
    headers.delete("connection");
    headers.delete("keep-alive");
    headers.delete("trailer");
    const encoding = headers.get("content-encoding")?.toLowerCase();
    let decoded = body.subarray(0, length);
    if (!bodyless && encoding && encoding !== "identity") {
      if (encoding !== "gzip" && encoding !== "deflate")
        fail("unsupported_encoding");
      decoded = await decodeContent(decoded, encoding, max, signal);
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
    if (!bodyless) headers.set("content-length", String(decoded.byteLength));
    return new Response(bodyless ? null : decoded, { status, headers });
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createPinnedHttpTransport(
  platform: PinnedTransportPlatform,
  options: { timeoutMs?: number } = {},
): HttpTransport {
  // The Run/import AbortSignal owns its shorter deadline. This absolute bound
  // must not silently shorten the approved 60s Run or 300s maximum.
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    fail("invalid_request");
  return {
    async request(input) {
      const { url, hostname, literal } = validateTransportUrl(input.url);
      const method = input.method;
      if (
        !/^[A-Z]+$/.test(method) ||
        ["CONNECT", "TRACE", "TRACK"].includes(method) ||
        !Number.isInteger(input.maxResponseBytes) ||
        input.maxResponseBytes < 0 ||
        input.maxResponseBytes > MAX_RESPONSE_BYTES ||
        (input.body?.byteLength ?? 0) > MAX_REQUEST_BYTES ||
        ((method === "GET" || method === "HEAD") && input.body?.byteLength)
      )
        fail("invalid_request");
      if (input.signal.aborted) fail("aborted");
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      let connection: PinnedConnection | undefined;
      let mayHaveDispatched = false;
      try {
        const headers = new Headers(input.headers);
        for (const [name, value] of headers) {
          if (
            !TOKEN.test(name) ||
            hasCodeUnitInRange(value, 0, 8) ||
            hasCodeUnitInRange(value, 10, 31) ||
            value.includes("\x7f") ||
            hasCodeUnitInRange(value, 256, 65535) ||
            [
              "host",
              "connection",
              "content-length",
              "transfer-encoding",
              "upgrade",
              "expect",
              "trailer",
              "proxy-authorization",
              "proxy-connection",
              "te",
            ].includes(name)
          )
            fail("invalid_request");
          if (
            name === "content-encoding" &&
            value.trim().toLowerCase() !== "identity"
          )
            fail("invalid_request");
        }
        headers.set("host", url.host);
        headers.set("connection", "close");
        headers.set("accept-encoding", "identity");
        if (input.body !== undefined)
          headers.set("content-length", String(input.body.byteLength));
        const requestLine = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
        const headerFrame = `${Array.from(headers, ([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`;
        if (
          encoder.encode(requestLine).byteLength > MAX_LINE ||
          encoder.encode(headerFrame).byteLength > MAX_REQUEST_HEADERS
        )
          fail("invalid_request");
        // Multipart's body ceiling is independent of generated HTTP framing.
        const frameBytes = encoder.encode(requestLine + headerFrame);
        const addresses = literal
          ? [hostname]
          : await abortable(
              platform.resolve(hostname, controller.signal),
              controller.signal,
            );
        if (!addresses.length || addresses.length > 64) fail("dns_failure");
        // Validate every answer, not only a preferred address. There is no
        // second hostname lookup or retry/failover to an unvetted endpoint.
        for (const address of addresses) assertPublicAddress(address);
        connection = await abortable(
          platform.connect({
            address: addresses[0]!,
            hostname,
            port: Number(url.port || 443),
            signal: controller.signal,
          }),
          controller.signal,
        );
        const writer = connection.writable.getWriter();
        try {
          // A rejected write may have partially transmitted bytes. Set this
          // BEFORE invoking write; never infer no effect from byte counters.
          mayHaveDispatched = true;
          await abortable(writer.write(frameBytes), controller.signal);
          if (input.body?.byteLength)
            await abortable(writer.write(input.body), controller.signal);
        } finally {
          writer.releaseLock();
        }
        return await readResponse(
          connection,
          method,
          input.maxResponseBytes,
          controller.signal,
        );
      } catch (error) {
        const dispatched =
          mayHaveDispatched ||
          (error instanceof TransportError && error.mayHaveDispatched);
        if (timedOut) throw new TransportError("timeout", dispatched);
        if (input.signal.aborted)
          throw new TransportError("aborted", dispatched);
        if (error instanceof TransportError)
          throw new TransportError(error.code, dispatched);
        throw new TransportError("connection_failure", dispatched);
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        controller.abort();
        connection?.close();
      }
    },
  };
}
