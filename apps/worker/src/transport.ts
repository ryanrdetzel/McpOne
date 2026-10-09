import { connect } from "cloudflare:sockets";
import { jsonProblem } from "@scaffold/schema/integrations";
import type { WasmTlsClient } from "../../../packages/core/src/integrations/tls-wasm.js";
import {
  abortable,
  assertPublicAddress,
  createPinnedHttpTransport,
  type HttpTransport,
  type PinnedConnection,
  readBoundedBody,
  TransportError,
} from "../../../packages/core/src/integrations/transport.js";
import { parseStrictJson } from "../../../packages/core/src/strict-json.js";

// DNS is a fixed, trusted HTTPS bootstrap dependency, not business egress.
// User input can change only the escaped DNS name, never this destination.
const DNS_ORIGIN = "https://cloudflare-dns.com/dns-query";

async function resolvePublicHostname(
  hostname: string,
  signal: AbortSignal,
): Promise<string[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const queries = await Promise.all(
      [1, 28].map(async (type) => {
        const url = new URL(DNS_ORIGIN);
        url.searchParams.set("name", hostname);
        url.searchParams.set("type", String(type));
        const response = await fetch(url, {
          headers: { Accept: "application/dns-json" },
          credentials: "omit",
          // Native Workers rejects "error"; the 200 guard below rejects redirects.
          redirect: "manual",
          signal: controller.signal,
        });
        if (
          response.status !== 200 ||
          response.headers.get("content-type")?.split(";")[0]?.trim() !==
            "application/dns-json"
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new TransportError("dns_failure");
        }
        const bytes = await readBoundedBody(
          response.body,
          64 * 1024,
          controller.signal,
        );
        const message: unknown = parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (jsonProblem(message, 64 * 1024))
          throw new TransportError("dns_failure");
        if (
          typeof message !== "object" ||
          message === null ||
          Array.isArray(message)
        )
          throw new TransportError("dns_failure");
        const data = message as Record<string, unknown>;
        if (
          data.Status !== 0 ||
          data.TC !== false ||
          !Array.isArray(data.Question) ||
          data.Question.length !== 1
        ) {
          throw new TransportError("dns_failure");
        }
        const question: unknown = data.Question[0];
        if (
          typeof question !== "object" ||
          question === null ||
          Array.isArray(question)
        )
          throw new TransportError("dns_failure");
        const q = question as Record<string, unknown>;
        if (
          q.type !== type ||
          typeof q.name !== "string" ||
          q.name.replace(/\.$/, "").toLowerCase() !== hostname.toLowerCase()
        ) {
          throw new TransportError("dns_failure");
        }
        const answers = data.Answer === undefined ? [] : data.Answer;
        if (!Array.isArray(answers) || answers.length > 64)
          throw new TransportError("dns_failure");
        const addresses: string[] = [];
        for (const answer of answers) {
          if (
            typeof answer !== "object" ||
            answer === null ||
            Array.isArray(answer)
          )
            throw new TransportError("dns_failure");
          const record = answer as Record<string, unknown>;
          if (record.type === 1 || record.type === 28) {
            if (typeof record.data !== "string")
              throw new TransportError("dns_failure");
            // Reject every forbidden address in either response, not just the
            // preferred/first answer. Core repeats this check before connecting.
            assertPublicAddress(record.data);
            addresses.push(record.data);
          }
        }
        return addresses;
      }),
    );
    const addresses = [...new Set(queries.flat())];
    if (addresses.length === 0 || addresses.length > 64)
      throw new TransportError("dns_failure");
    return addresses;
  } catch (error) {
    controller.abort();
    if (error instanceof TransportError && error.code === "unsafe_target")
      throw error;
    throw new TransportError(signal.aborted ? "aborted" : "dns_failure");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function createWorkerHttpTransport(tls: WasmTlsClient): HttpTransport {
  return createPinnedHttpTransport({
    resolve: resolvePublicHostname,
    async connect({ address, hostname, port, signal }) {
      assertPublicAddress(address);
      if (port !== 443 || signal.aborted)
        throw new TransportError(signal.aborted ? "aborted" : "unsafe_target");
      // Literal address only. Socket TLS/startTls is deliberately not used:
      // deployed edge cannot verify original SNI hostname on this numeric peer.
      const socket = connect(
        { hostname: address, port },
        { secureTransport: "off", allowHalfOpen: true },
      );
      let closed = false;
      const raw: PinnedConnection = {
        readable: socket.readable,
        writable: socket.writable,
        close() {
          if (closed) return;
          closed = true;
          void socket.close().catch(() => undefined);
        },
      };
      // The closed promise can reject independently of opened/stream consumers.
      void socket.closed.catch(() => undefined);
      const abort = () => raw.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await abortable(socket.opened, signal);
        if (signal.aborted) throw new TransportError("aborted");
        return await tls.connect({ socket: raw, hostname, signal });
      } catch (error) {
        raw.close();
        if (error instanceof TransportError) throw error;
        throw new TransportError(
          signal.aborted ? "aborted" : "connection_failure",
        );
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
