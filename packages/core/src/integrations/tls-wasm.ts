import {
  abortable,
  type PinnedConnection,
  parseAddress,
  TransportError,
} from "./transport.js";

const MEMORY_BYTES = 16 * 1024 * 1024;
const HANDSHAKE_BYTES = 256 * 1024;
const QUEUE_BYTES = 64 * 1024;
const WANT_READ = -0x6900;
const WANT_WRITE = -0x6880;
const encoder = new TextEncoder();

interface TlsExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  tls_version(): number;
  tls_buffer(): number;
  tls_buffer_size(): number;
  tls_alloc(size: number): number;
  tls_free(pointer: number): void;
  tls_init(ca: number, size: number, hostname: number): number;
  tls_destroy(): void;
  tls_feed(size: number): number;
  tls_eof(): void;
  tls_drain(): number;
  tls_handshake(): number;
  tls_read(): number;
  tls_write(size: number): number;
  tls_close_notify(): number;
}

export interface WasmTlsClient {
  connect(input: {
    socket: PinnedConnection;
    hostname: string;
    signal: AbortSignal;
  }): Promise<PinnedConnection>;
}

// The module and public roots are static trusted deployment dependencies, never
// guest-supplied/request-downloaded code. Import allow-list denies ambient I/O.
export function createWasmTlsClient(input: {
  module: WebAssembly.Module;
  caBundle: Uint8Array;
}): WasmTlsClient {
  if (
    input.caBundle.byteLength === 0 ||
    input.caBundle.byteLength >= 512 * 1024
  ) {
    throw new TransportError("connection_failure");
  }
  for (const entry of WebAssembly.Module.imports(input.module)) {
    const allowed =
      entry.kind === "function" &&
      ((entry.module === "mcpone" &&
        ["random", "now", "utc"].includes(entry.name)) ||
        (entry.module === "wasi_snapshot_preview1" &&
          entry.name === "proc_exit") ||
        (entry.module === "env" && entry.name === "abort"));
    if (!allowed) throw new TransportError("connection_failure");
  }
  // Copy once; the caller cannot replace roots while a connection is verifying.
  const roots = input.caBundle.slice();

  return {
    async connect({ socket, hostname, signal }) {
      if (
        !parseAddress(hostname) &&
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
          hostname,
        )
      ) {
        socket.close();
        throw new TransportError("unsafe_target");
      }
      const controller = new AbortController();
      const aborted = () => controller.abort(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 10_000);
      const liveSignal = controller.signal;
      let native: TlsExports | undefined;
      let closed = false;
      let validationDenied = false;
      let handshake = true;
      let handshakeBytes = 0;
      const reader = socket.readable.getReader();
      const writer = socket.writable.getWriter();
      let outputTail = Promise.resolve();
      let receiving: Promise<void> | undefined;
      let incoming: Uint8Array | undefined;
      let incomingOffset = 0;
      let tcpEof = false;
      let streamController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;

      function failure(): TransportError {
        return new TransportError(
          timedOut
            ? "timeout"
            : signal.aborted
              ? "aborted"
              : validationDenied
                ? "tls_validation_failed"
                : "connection_failure",
        );
      }
      function rejectNative(result: number): never {
        // Mbed TLS combines high-level errors with seven-bit low-level causes.
        // Resource failures, bare TCP EOF and internal RNG failure are not
        // certificate/policy denials. All other terminal native errors are
        // permanent TLS validation/protocol failures, never retryable dial errors.
        const category = Math.abs(result) & ~0x7f;
        if (category === 0x6800) timedOut = true;
        else if (
          (Math.abs(result) & 0x7f) !== 0x10 &&
          ![0x2880, 0x3f80, 0x4d80, 0x6c00, 0x7280, 0x7f00].includes(category)
        )
          validationDenied = true;
        throw failure();
      }
      function view(): Uint8Array {
        if (!native || native.memory.buffer.byteLength !== MEMORY_BYTES)
          throw failure();
        return new Uint8Array(native.memory.buffer);
      }
      function live(): void {
        if (closed || liveSignal.aborted) throw failure();
      }
      function close(): void {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        liveSignal.removeEventListener("abort", onAbort);
        socket.close();
        void reader.cancel().catch(() => undefined);
        void writer.abort().catch(() => undefined);
        native?.tls_destroy();
        // Destroy all TLS key/plaintext heap state, not just the exported queues.
        if (native) new Uint8Array(native.memory.buffer).fill(0);
        native = undefined;
        incoming = undefined;
      }
      function onAbort(): void {
        streamController?.error(failure());
        close();
      }
      liveSignal.addEventListener("abort", onAbort, { once: true });
      function charge(size: number): void {
        if (!handshake) return;
        handshakeBytes += size;
        if (handshakeBytes > HANDSHAKE_BYTES) {
          validationDenied = true;
          throw failure();
        }
      }
      // Every native call and memory copy below is synchronous: read and write
      // can await independently without retaining/overwriting WASM views.
      function drain(): Promise<void> {
        const engine = native!;
        let size = engine.tls_drain();
        while (size > 0) {
          if (size > engine.tls_buffer_size()) throw failure();
          charge(size);
          const bytes = view().slice(
            engine.tls_buffer(),
            engine.tls_buffer() + size,
          );
          outputTail = outputTail.then(async () => {
            live();
            await abortable(writer.write(bytes), liveSignal);
          });
          // Prevent unhandled rejection if another concurrent TLS operation fails.
          void outputTail.catch(() => undefined);
          size = engine.tls_drain();
        }
        if (size < 0) throw failure();
        return outputTail;
      }
      async function receive(): Promise<void> {
        live();
        if (!receiving) {
          receiving = (async () => {
            if (!incoming && !tcpEof) {
              const result = await abortable(reader.read(), liveSignal);
              live();
              if (result.done) tcpEof = true;
              else {
                if (
                  result.value.byteLength === 0 ||
                  result.value.byteLength > QUEUE_BYTES
                )
                  throw failure();
                incoming = result.value;
                incomingOffset = 0;
                charge(incoming.byteLength);
              }
            }
            live();
            if (tcpEof) {
              native!.tls_eof();
              return;
            }
            const size = Math.min(
              native!.tls_buffer_size(),
              incoming!.byteLength - incomingOffset,
            );
            view().set(
              incoming!.subarray(incomingOffset, incomingOffset + size),
              native!.tls_buffer(),
            );
            if (native!.tls_feed(size) !== size) throw failure();
            incomingOffset += size;
            if (incomingOffset === incoming!.byteLength) incoming = undefined;
          })().finally(() => {
            receiving = undefined;
          });
        }
        await receiving;
      }
      async function retry(
        result: number,
        flushed: Promise<void>,
      ): Promise<void> {
        // Classify denial before flushing its TLS alert: a peer reset while
        // sending that alert must not turn a known denial into a retryable dial.
        if (result !== WANT_READ && result !== WANT_WRITE) rejectNative(result);
        await flushed;
        live();
        if (result === WANT_READ) await receive();
      }
      function store(bytes: Uint8Array, terminate: boolean): number {
        const pointer = native!.tls_alloc(
          bytes.byteLength + (terminate ? 1 : 0),
        );
        if (!pointer) throw failure();
        view().set(bytes, pointer);
        if (terminate) view()[pointer + bytes.byteLength] = 0;
        return pointer;
      }
      try {
        live();
        const instance = await WebAssembly.instantiate(input.module, {
          mcpone: {
            random(pointer: number, size: number): number {
              try {
                const memory = view();
                if (
                  !Number.isInteger(size) ||
                  size < 0 ||
                  pointer < 0 ||
                  pointer + size > memory.byteLength
                )
                  return -1;
                for (let offset = 0; offset < size; offset += 65536) {
                  crypto.getRandomValues(
                    memory.subarray(
                      pointer + offset,
                      pointer + Math.min(size, offset + 65536),
                    ),
                  );
                }
                return 0;
              } catch {
                return -1;
              }
            },
            now: () => Date.now() / 1000,
            utc(seconds: number, pointer: number): number {
              const date = new Date(seconds * 1000);
              if (
                !Number.isFinite(seconds) ||
                !Number.isFinite(date.getTime()) ||
                seconds < 0 ||
                seconds > 253402300799
              )
                return -1;
              const fields = new Int32Array(view().buffer, pointer, 6);
              fields.set([
                date.getUTCFullYear(),
                date.getUTCMonth() + 1,
                date.getUTCDate(),
                date.getUTCHours(),
                date.getUTCMinutes(),
                date.getUTCSeconds(),
              ]);
              return 0;
            },
          },
          wasi_snapshot_preview1: {
            proc_exit: () => {
              throw failure();
            },
          },
          env: {
            abort: () => {
              throw failure();
            },
          },
        });
        live();
        native = instance.exports as TlsExports;
        const initialize = native._initialize;
        if (typeof initialize === "function") initialize();
        view();
        if (
          native.tls_version() !== 0x03060700 ||
          native.tls_buffer_size() !== 16384
        )
          throw failure();
        const ca = store(roots, true);
        let name = 0;
        try {
          name = store(encoder.encode(hostname), true);
          const result = native.tls_init(ca, roots.byteLength + 1, name);
          if (result !== 0) rejectNative(result);
        } finally {
          native.tls_free(ca);
          if (name) native.tls_free(name);
        }
        for (;;) {
          live();
          const result = native.tls_handshake();
          const flushed = drain();
          if (result === 0) {
            await flushed;
            break;
          }
          await retry(result, flushed);
        }
        live();
        handshake = false;
        clearTimeout(timer);
        const readable = new ReadableStream<Uint8Array>(
          {
            start(value) {
              streamController = value;
            },
            async pull(controller) {
              try {
                for (;;) {
                  live();
                  const result = native!.tls_read();
                  const plaintext =
                    result > 0
                      ? view().slice(
                          native!.tls_buffer(),
                          native!.tls_buffer() + result,
                        )
                      : undefined;
                  const flushed = drain();
                  if (result >= 0) {
                    await flushed;
                    if (plaintext) controller.enqueue(plaintext);
                    else {
                      controller.close();
                      close();
                    }
                    return;
                  }
                  await retry(result, flushed);
                }
              } catch {
                controller.error(failure());
                close();
              }
            },
            cancel() {
              close();
            },
          },
          { highWaterMark: 0 },
        );
        const writable = new WritableStream<Uint8Array>(
          {
            async write(bytes) {
              try {
                let offset = 0;
                while (offset < bytes.byteLength) {
                  live();
                  const size = Math.min(
                    native!.tls_buffer_size(),
                    bytes.byteLength - offset,
                  );
                  view().set(
                    bytes.subarray(offset, offset + size),
                    native!.tls_buffer(),
                  );
                  const result = native!.tls_write(size);
                  const flushed = drain();
                  if (result > 0) {
                    if (result > size) throw failure();
                    offset += result;
                    await flushed;
                  } else await retry(result, flushed);
                }
              } catch {
                close();
                throw failure();
              }
            },
            async close() {
              try {
                for (;;) {
                  live();
                  const result = native!.tls_close_notify();
                  const flushed = drain();
                  if (result === 0) {
                    await flushed;
                    return;
                  }
                  await retry(result, flushed);
                }
              } catch {
                close();
                throw failure();
              }
            },
            abort() {
              close();
            },
          },
          { highWaterMark: 1 },
        );
        return { readable, writable, close };
      } catch {
        close();
        throw failure();
      }
    },
  };
}
