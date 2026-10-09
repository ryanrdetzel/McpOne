import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, ".state/m2-toolchain");
const downloads = join(cache, "downloads");
const manifest = JSON.parse(
  await readFile(join(root, "apps/worker/tls/manifest.json"), "utf8"),
);
const sdk = {
  version: "6.0.11",
  commit: "dd8e25632640cfc1fb570c7fa4cc374e8a5e5a72",
  sha256: "f57126eb845e04325a3d3d7711dbddc159ff0e8516c331d28cf01476bf72dc0b",
};
const sdkDirectory = join(cache, `emsdk-${sdk.commit}`);
const sourceDirectory = join(cache, `mbedtls-${manifest.engine.version}`);
const output = resolve(root, manifest.runtime.output);
const buildRecord = join(cache, "tls-build.json");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exportedFunctions = manifest.runtime.exports
  .filter((name) => name !== "memory")
  .map((name) => `_${name}`);
const flags = [
  "-DNDEBUG",
  "-O2",
  "--no-entry",
  "-sSTANDALONE_WASM=1",
  "-sFILESYSTEM=0",
  "-sASSERTIONS=0",
  "-sMALLOC=emmalloc",
  "-sALLOW_MEMORY_GROWTH=0",
  "-sINITIAL_MEMORY=16777216",
  "-sSTACK_SIZE=262144",
  `-sEXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
  '-DMBEDTLS_CONFIG_FILE="mbedtls-config.h"',
];
const configuration = await readFile(
  resolve(root, manifest.engine.configuration),
);
const bridge = await readFile(resolve(root, manifest.engine.bridge));
const caBundle = await readFile(resolve(root, manifest.caBundle.path));
if (
  digest(caBundle) !== manifest.caBundle.sha256 ||
  caBundle.byteLength !== manifest.caBundle.bytes
) {
  throw new Error(
    "Public TLS trust bundle does not match its reviewed provenance",
  );
}
const inputs = {
  sdk,
  engine: manifest.engine,
  runtime: manifest.runtime,
  caSha256: manifest.caBundle.sha256,
  configurationSha256: digest(configuration),
  bridgeSha256: digest(bridge),
  flags,
};
const inputsDigest = digest(JSON.stringify(inputs));
await mkdir(downloads, { recursive: true, mode: 0o700 });
await mkdir(join(root, "apps/worker/dist"), { recursive: true });

function inspectModule(bytes) {
  if (!WebAssembly.validate(bytes))
    throw new Error("TLS compiler produced invalid WebAssembly");
  const module = new WebAssembly.Module(bytes);
  const permitted = new Set([
    ...manifest.runtime.imports,
    ...manifest.runtime.optionalTrapImports,
  ]);
  for (const entry of WebAssembly.Module.imports(module)) {
    if (
      entry.kind !== "function" ||
      !permitted.has(`${entry.module}.${entry.name}`)
    ) {
      throw new Error(
        `Unexpected TLS module capability: ${entry.module}.${entry.name}`,
      );
    }
  }
  const exported = new Map(
    WebAssembly.Module.exports(module).map((entry) => [entry.name, entry.kind]),
  );
  for (const name of manifest.runtime.exports) {
    if (exported.get(name) !== (name === "memory" ? "memory" : "function")) {
      throw new Error(`TLS module is missing ABI export ${name}`);
    }
  }
  // Inspect the declared memory maximum without instantiating or executing native code.
  let offset = 8;
  const integer = () => {
    let value = 0;
    let shift = 0;
    for (let count = 0; count < 5; count += 1) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated TLS module section");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error("Invalid TLS module section integer");
  };
  let memoryFound = false;
  while (offset < bytes.length) {
    const section = bytes[offset++];
    const size = integer();
    const end = offset + size;
    if (end > bytes.length)
      throw new Error("Invalid TLS module section length");
    if (section === 5) {
      if (
        integer() !== 1 ||
        integer() !== 1 ||
        integer() !== 256 ||
        integer() !== 256 ||
        offset !== end
      ) {
        throw new Error(
          "TLS module must declare exactly one fixed 16 MiB memory",
        );
      }
      memoryFound = true;
    }
    offset = end;
  }
  if (!memoryFound) throw new Error("TLS module has no fixed linear memory");
}

try {
  const record = JSON.parse(await readFile(buildRecord, "utf8"));
  const bytes = await readFile(output);
  if (record.inputsDigest === inputsDigest && record.sha256 === digest(bytes)) {
    inspectModule(bytes);
    console.log(
      `TLS WASM verified: ${bytes.byteLength} bytes, SHA-256 ${record.sha256}`,
    );
    process.exit(0);
  }
} catch (error) {
  if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
}

async function run(command, args, environment = {}) {
  const childEnvironment = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
  ]) {
    if (process.env[key]) childEnvironment[key] = process.env[key];
  }
  await new Promise((resolveChild, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...childEnvironment, ...environment },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolveChild()
        : reject(
            new Error(
              `Public TLS build command failed (${signal ?? code}): ${command}`,
            ),
          ),
    );
  });
}

async function download(url, path, expectedDigest, maximumBytes) {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength <= maximumBytes && digest(bytes) === expectedDigest)
      return;
    throw new Error(
      "Cached public source archive has an unexpected digest; remove the named archive and retry",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body)
    throw new Error(
      `Public source download failed with HTTP ${response.status}`,
    );
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > maximumBytes)
      throw new Error("Public source archive exceeds its download bound");
    parts.push(part);
  }
  const bytes = Buffer.concat(parts, size);
  if (digest(bytes) !== expectedDigest)
    throw new Error("Public source archive checksum mismatch");
  const temporary = `${path}.partial`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

await run("python3", ["--version"]);
const sdkArchive = join(downloads, "emsdk-dd8e2563.tar.gz");
await download(
  `https://codeload.github.com/emscripten-core/emsdk/tar.gz/${sdk.commit}`,
  sdkArchive,
  sdk.sha256,
  1024 * 1024,
);
try {
  await stat(join(sdkDirectory, "emsdk.py"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await run("tar", ["-xzf", sdkArchive, "-C", cache]);
}
const compiler = join(sdkDirectory, "upstream/emscripten/emcc");
const sdkEnvironment = {
  EMSDK: sdkDirectory,
  EM_CONFIG: join(sdkDirectory, ".emscripten"),
  EM_CACHE: join(cache, "emscripten-cache"),
};
try {
  await stat(compiler);
  await stat(sdkEnvironment.EM_CONFIG);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await run(
    "python3",
    [join(sdkDirectory, "emsdk.py"), "install", sdk.version],
    sdkEnvironment,
  );
  await run(
    "python3",
    [join(sdkDirectory, "emsdk.py"), "activate", sdk.version],
    sdkEnvironment,
  );
}
const sourceArchive = join(
  downloads,
  `mbedtls-${manifest.engine.version}.tar.bz2`,
);
await download(
  manifest.engine.source,
  sourceArchive,
  manifest.engine.sha256,
  16 * 1024 * 1024,
);
try {
  await stat(join(sourceDirectory, "library/ssl_tls.c"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await run("tar", ["-xjf", sourceArchive, "-C", cache]);
}
const sources = (await readdir(join(sourceDirectory, "library")))
  .filter((name) => name.endsWith(".c"))
  .sort()
  .map((name) => join(sourceDirectory, "library", name));
const temporaryOutput = join(root, "apps/worker/dist/tls.partial.wasm");
await run(
  compiler,
  [
    ...sources,
    resolve(root, manifest.engine.bridge),
    `-I${join(sourceDirectory, "include")}`,
    `-I${join(sourceDirectory, "library")}`,
    `-I${join(root, "packages/core/tls")}`,
    ...flags,
    "-o",
    temporaryOutput,
  ],
  sdkEnvironment,
);
const bytes = await readFile(temporaryOutput);
inspectModule(bytes);
const sha256 = digest(bytes);
await rename(temporaryOutput, output);
await writeFile(
  buildRecord,
  `${JSON.stringify({ format: "mcpone-tls-build-v1", inputsDigest, inputs, bytes: bytes.byteLength, sha256 }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`TLS WASM built: ${bytes.byteLength} bytes, SHA-256 ${sha256}`);
