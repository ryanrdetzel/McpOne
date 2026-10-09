import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createNetServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { createServer as createTlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWasmTlsClient } from "../src/integrations/tls-wasm";
import type { PinnedConnection } from "../src/integrations/transport";

// These keys are generated only in an owner-private temporary directory. Nothing
// is tracked, printed, or trusted by live transport. The native client is the SAME
// static MbedTLS WASM wrapper used by the Worker, not Node TLS masquerading as it.
// Raw localhost sockets isolate TLS identity verification from the separate SSRF
// policy tests; no application broker/private-address exception is installed.
let directory: string;
let module: WebAssembly.Module;
const fixtures = new Map<string, { cert: Buffer; roots: Buffer }>();
let key: Buffer;
function put(name: string, value: string) {
  writeFileSync(join(directory, name), value, { mode: 0o600 });
}
function openssl(...args: string[]) {
  try {
    execFileSync("openssl", args, {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("OpenSSL public synthetic TLS fixture generation failed");
  }
}
function root(
  name: string,
  pathLength = 20,
  digest: "sha256" | "sha1" = "sha256",
) {
  openssl(
    "req",
    "-x509",
    "-new",
    "-key",
    "key.pem",
    `-${digest}`,
    "-days",
    "2",
    "-subj",
    `/CN=M2 Public Test ${name}`,
    "-out",
    `${name}.pem`,
    "-addext",
    `basicConstraints=critical,CA:TRUE,pathlen:${pathLength}`,
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
}
function sign(
  name: string,
  issuer: string,
  extensions: string,
  commonName = "localhost",
  digest: "sha256" | "sha1" = "sha256",
) {
  openssl(
    "req",
    "-new",
    "-key",
    "key.pem",
    "-subj",
    `/CN=${commonName}`,
    "-out",
    `${name}.csr`,
  );
  put(`${name}.ext`, extensions);
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${issuer}.pem`,
    "-CAkey",
    "key.pem",
    "-CAcreateserial",
    "-out",
    `${name}.pem`,
    "-days",
    "2",
    `-${digest}`,
    "-extfile",
    `${name}.ext`,
  );
}
const leaf = (san?: string, usage = "serverAuth") =>
  `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n${san ? `subjectAltName=${san}\n` : ""}`;
const intermediate = (ca = true, pathLength = 20) =>
  `basicConstraints=critical,CA:${ca ? `TRUE,pathlen:${pathLength}` : "FALSE"}\nkeyUsage=critical,${ca ? "keyCertSign,cRLSign" : "digitalSignature"}\n`;
function fixture(name: string, chain: string[], trust = "root") {
  fixtures.set(name, {
    cert: Buffer.concat(
      chain.map((item) => readFileSync(join(directory, `${item}.pem`))),
    ),
    roots: readFileSync(join(directory, `${trust}.pem`)),
  });
}
async function pinned(port: number): Promise<PinnedConnection> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const value = netConnect({ port, host: "127.0.0.1" });
    value.once("error", reject);
    value.once("connect", () => resolve(value));
  });
  return {
    readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
    close: () => socket.destroy(),
  };
}
async function serve<T>(
  server: Server,
  action: (port: number) => Promise<T>,
): Promise<T> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined); // Expected peer teardown still reaches the native stream reader.
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("TLS fixture listener unavailable"));
      resolve(address.port);
    });
  });
  try {
    return await action(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function authenticate(name: string, hostname: string) {
  const data = fixtures.get(name);
  if (!data) throw new Error("Unknown public TLS fixture");
  // Only the adversarial synthetic SERVER permits weak chain signatures so the
  // actual unchanged native client, not Node/OpenSSL, must reject SHA1 peers.
  const weakFixture = name === "sha1-leaf" || name === "sha1-chain";
  const server = createTlsServer(
    {
      key,
      cert: data.cert,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers: `ECDHE-RSA-AES128-GCM-SHA256${weakFixture ? ":@SECLEVEL=0" : ""}`,
      ALPNProtocols: ["http/1.1"],
    },
    (socket) => socket.on("error", () => undefined),
  );
  server.on("tlsClientError", () => undefined); // Deliberately invalid certificates cause a real peer alert.
  return serve(server, async (port) => {
    const socket = await pinned(port);
    try {
      const connection = await createWasmTlsClient({
        module,
        caBundle: data.roots,
      }).connect({ socket, hostname, signal: AbortSignal.timeout(15_000) });
      connection.close();
    } finally {
      socket.close();
    }
  });
}

beforeAll(() => {
  // Missing real build artifact is a failed prerequisite, never a conditional skip.
  module = new WebAssembly.Module(
    new Uint8Array(
      readFileSync(
        new URL("../../../apps/worker/dist/tls.wasm", import.meta.url),
      ),
    ),
  );
  directory = mkdtempSync(join(tmpdir(), "mcpone-public-tls-tests-"));
  openssl(
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    "key.pem",
  );
  chmodSync(join(directory, "key.pem"), 0o600);
  key = readFileSync(join(directory, "key.pem"));
  root("root");
  root("untrusted");
  root("pathzero", 0);
  sign("valid", "root", leaf("DNS:localhost"));
  fixture("valid", ["valid"]);
  sign("untrusted-leaf", "untrusted", leaf("DNS:localhost"));
  fixture("untrusted", ["untrusted-leaf"]);
  root("legacy-root", 20, "sha1");
  sign("legacy-root-leaf", "legacy-root", leaf("DNS:localhost"));
  fixture("legacy-root-valid", ["legacy-root-leaf"], "legacy-root");
  sign("sha1-leaf", "root", leaf("DNS:localhost"), "localhost", "sha1");
  fixture("sha1-leaf", ["sha1-leaf"]);
  sign(
    "sha1-intermediate",
    "root",
    intermediate(),
    "M2 Public SHA1 Intermediate",
    "sha1",
  );
  sign("sha1-chain-leaf", "sha1-intermediate", leaf("DNS:localhost"));
  fixture("sha1-chain", ["sha1-chain-leaf", "sha1-intermediate"]);
  sign("cn-only", "root", leaf(), "localhost");
  fixture("cn-only", ["cn-only"]);
  sign("san-over-cn", "root", leaf("DNS:unmatched.example.test"), "localhost");
  fixture("san-over-cn", ["san-over-cn"]);
  sign(
    "uri-over-dns",
    "root",
    leaf("URI:example.test,DNS:unmatched.example.test"),
    "example.test",
  );
  fixture("uri-over-dns", ["uri-over-dns"]);
  sign("uri-only", "root", leaf("URI:localhost"), "localhost");
  fixture("uri-only", ["uri-only"]);
  sign("client-eku", "root", leaf("DNS:localhost", "clientAuth"));
  fixture("client-eku", ["client-eku"]);
  sign("wildcard", "root", leaf("DNS:*.example.test"), "ignored.example.test");
  fixture("wildcard", ["wildcard"]);
  sign("ip", "root", leaf("IP:127.0.0.1"));
  fixture("ip", ["ip"]);
  sign("ipv6", "root", leaf("IP:::1"));
  fixture("ipv6", ["ipv6"]);
  sign("dns-numeric", "root", leaf("DNS:127.0.0.1"));
  fixture("dns-numeric", ["dns-numeric"]);
  sign("ip-cn-only", "root", leaf(), "127.0.0.1");
  fixture("ip-cn-only", ["ip-cn-only"]);
  sign("non-ca", "root", intermediate(false), "M2 Public Non CA");
  sign("non-ca-leaf", "non-ca", leaf("DNS:localhost"));
  fixture("non-ca", ["non-ca-leaf", "non-ca"]);
  sign(
    "path-intermediate",
    "pathzero",
    intermediate(),
    "M2 Public Path Intermediate",
  );
  sign("path-leaf", "path-intermediate", leaf("DNS:localhost"));
  fixture("path-length", ["path-leaf", "path-intermediate"], "pathzero");
  let issuer = "root";
  const chain: string[] = [];
  for (let index = 0; index < 11; index++) {
    const name = `depth-${index}`;
    sign(name, issuer, intermediate(), `M2 Public Depth ${index}`);
    chain.unshift(name);
    issuer = name;
  }
  sign("depth-leaf", issuer, leaf("DNS:localhost"));
  fixture("depth", ["depth-leaf", ...chain]);
  sign(
    "oversized",
    "root",
    `${leaf("DNS:localhost")}nsComment=${"x".repeat(270_000)}\n`,
  );
  fixture("oversized", ["oversized"]);
  mkdirSync(join(directory, "issued"), { mode: 0o700 });
  put("index", "");
  put("serial", "1000\n");
  put(
    "expired.cnf",
    "[ca]\ndefault_ca=test\n[test]\ndatabase=index\nnew_certs_dir=issued\ncertificate=root.pem\nprivate_key=key.pem\nserial=serial\ndefault_md=sha256\ndefault_days=1\npolicy=policy\nx509_extensions=leaf\nunique_subject=no\n[policy]\ncommonName=supplied\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n",
  );
  openssl(
    "ca",
    "-batch",
    "-notext",
    "-config",
    "expired.cnf",
    "-in",
    "valid.csr",
    "-out",
    "expired.pem",
    "-startdate",
    "20200101000000Z",
    "-enddate",
    "20210101000000Z",
  );
  fixture("expired", ["expired"]);
}, 120_000);
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("same static native TLS/X509 engine over real sockets", () => {
  for (const [name, hostname] of [
    ["valid", "localhost"],
    ["valid", "LOCALHOST"],
    ["cn-only", "localhost"],
    ["wildcard", "one.example.test"],
    ["ip", "127.0.0.1"],
    ["ipv6", "::1"],
    ["legacy-root-valid", "localhost"],
  ] as const) {
    it(`authenticates ${name} for ${hostname}`, async () => {
      await authenticate(name, hostname);
    }, 30_000);
  }
  for (const [name, hostname] of [
    ["valid", "unmatched.example.test"],
    ["untrusted", "localhost"],
    ["expired", "localhost"],
    ["non-ca", "localhost"],
    ["path-length", "localhost"],
    ["depth", "localhost"],
    ["oversized", "localhost"],
    ["client-eku", "localhost"],
    ["san-over-cn", "localhost"],
    ["uri-over-dns", "example.test"],
    ["uri-only", "localhost"],
    ["wildcard", "two.one.example.test"],
    ["wildcard", "example.test"],
    ["dns-numeric", "127.0.0.1"],
    ["ip-cn-only", "127.0.0.1"],
    ["sha1-leaf", "localhost"],
    ["sha1-chain", "localhost"],
  ] as const) {
    it(`rejects ${name} for ${hostname}`, async () => {
      await expect(authenticate(name, hostname)).rejects.toMatchObject({
        code: "tls_validation_failed",
      });
    }, 30_000);
  }
  it("rejects a corrupt TLS record before returning authenticated streams", async () => {
    // Illegal TLS record content type, not an incomplete handshake whose
    // advertised message length legitimately leaves the parser awaiting TCP.
    const server = createNetServer((socket) =>
      socket.once("data", () =>
        socket.end(Buffer.from([255, 3, 3, 0, 4, 255, 255, 255, 255])),
      ),
    );
    await serve(server, async (port) => {
      const socket = await pinned(port);
      try {
        await expect(
          createWasmTlsClient({
            module,
            caBundle: fixtures.get("valid")!.roots,
          }).connect({
            socket,
            hostname: "localhost",
            signal: AbortSignal.timeout(15_000),
          }),
        ).rejects.toMatchObject({ code: "tls_validation_failed" });
      } finally {
        socket.close();
      }
    });
  }, 30_000);
  it("aborts a real stalled handshake and closes the socket", async () => {
    const controller = new AbortController();
    // Abort after the actual ClientHello arrives, not after a guessed sleep.
    const server = createNetServer((socket) =>
      socket.once("data", () => controller.abort()),
    );
    await serve(server, async (port) => {
      const socket = await pinned(port);
      try {
        await expect(
          createWasmTlsClient({
            module,
            caBundle: fixtures.get("valid")!.roots,
          }).connect({
            socket,
            hostname: "localhost",
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({ code: "aborted" });
      } finally {
        socket.close();
      }
    });
  }, 30_000);
  it("fails a real handshake at its own bounded timeout without fake clocks", async () => {
    // Deliberate integration proof of the native 10-second platform-clock deadline;
    // fake timers cannot stand in for the real socket/native-engine interaction.
    await serve(createNetServer(), async (port) => {
      const socket = await pinned(port);
      try {
        await expect(
          createWasmTlsClient({
            module,
            caBundle: fixtures.get("valid")!.roots,
          }).connect({
            socket,
            hostname: "localhost",
            signal: AbortSignal.timeout(15_000),
          }),
        ).rejects.toMatchObject({ code: "timeout" });
      } finally {
        socket.close();
      }
    });
  }, 30_000);
});
