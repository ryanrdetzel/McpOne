import { Resolver } from "node:dns/promises";
import { Duplex, type DuplexOptions } from "node:stream";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { checkServerIdentity, connect } from "node:tls";
import {
  createPinnedHttpTransport,
  type HttpTransport,
  type PinnedConnection,
  parseAddress,
  TransportError,
} from "../../../packages/core/src/integrations/transport";

export function createLocalHttpTransport(): HttpTransport {
  return createPinnedHttpTransport({
    async resolve(hostname, signal) {
      // A request-scoped resolver permits cancellation without affecting other
      // requests. OS-configured recursive resolvers are trusted infrastructure;
      // all returned numeric destinations are still validated before dialing.
      const resolver = new Resolver({ timeout: 3_000, tries: 1 });
      const cancel = () => resolver.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (signal.aborted) throw new TransportError("aborted");
        const answers = await Promise.all(
          [resolver.resolve4(hostname), resolver.resolve6(hostname)].map(
            async (query) => {
              try {
                return await query;
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENODATA" || code === "ENOTFOUND") return [];
                throw new TransportError("dns_failure");
              }
            },
          ),
        );
        return [...new Set(answers.flat())];
      } finally {
        signal.removeEventListener("abort", cancel);
        resolver.cancel();
      }
    },
    async connect({
      address,
      hostname,
      port,
      signal,
    }): Promise<PinnedConnection> {
      if (signal.aborted) throw new TransportError("aborted");
      // host is a vetted numeric literal, never the hostname: there is no
      // second DNS lookup. Certificate identity and SNI use the original host.
      // Node documents tls.connect/checkServerIdentity at nodejs.org/api/tls.html.
      let socket: TLSSocket;
      try {
        const options = {
          host: address,
          port,
          servername: parseAddress(hostname) ? undefined : hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) =>
            checkServerIdentity(hostname, certificate),
          ALPNProtocols: ["http/1.1"],
          minVersion: "TLSv1.2",
          highWaterMark: 16 * 1024,
        } satisfies ConnectionOptions & Pick<DuplexOptions, "highWaterMark">;
        socket = connect(options);
      } catch {
        throw new TransportError("tls_validation_failed");
      }
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const aborted = () => {
        socket.destroy();
        reject(new TransportError("aborted"));
      };
      // Keep a sanitized error listener for the entire socket lifetime. The
      // streaming adapter also observes errors once the handshake has finished.
      socket.on("error", (error: NodeJS.ErrnoException) => {
        // Only positive network-error classes are retryable. Certificate,
        // chain, hostname, algorithm and unknown handshake-policy denials are
        // permanent, never a generic pre-dispatch connection retry.
        const transient = [
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "EPIPE",
        ].includes(error.code ?? "");
        reject(
          new TransportError(
            transient ? "connection_failure" : "tls_validation_failed",
          ),
        );
      });
      socket.once("secureConnect", () => resolve());
      signal.addEventListener("abort", aborted, { once: true });
      try {
        await promise;
        if (signal.aborted) throw new TransportError("aborted");
        const peer = socket.remoteAddress
          ? parseAddress(socket.remoteAddress)
          : null;
        const target = parseAddress(address);
        if (!socket.authorized)
          throw new TransportError("tls_validation_failed");
        if (
          !peer ||
          !target ||
          peer.bits !== target.bits ||
          peer.value !== target.value
        )
          throw new TransportError("unsafe_target");
        if (socket.alpnProtocol && socket.alpnProtocol !== "http/1.1")
          throw new TransportError("unsupported_destination");
        const streams = Duplex.toWeb(socket);
        return {
          readable: streams.readable as ReadableStream<Uint8Array>,
          writable: streams.writable as WritableStream<Uint8Array>,
          close() {
            signal.removeEventListener("abort", aborted);
            socket.destroy();
          },
        };
      } catch (error) {
        signal.removeEventListener("abort", aborted);
        socket.destroy();
        throw error;
      }
    },
  });
}
