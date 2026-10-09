import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, "scripts/build-tls.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) =>
    code === 0
      ? resolve()
      : reject(new Error(`Static TLS build failed (${signal ?? code})`)),
  );
});
const require = createRequire(join(root, "packages/core/package.json"));
const source = require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
const bytes = await readFile(source);
if (!WebAssembly.validate(bytes))
  throw new Error("Pinned QuickJS package contains invalid WebAssembly");
await mkdir(join(root, "apps/worker/dist"), { recursive: true });
await writeFile(join(root, "apps/worker/dist/quickjs.wasm"), bytes);
console.log(
  `QuickJS 0.32.0 WASM packaged: ${bytes.byteLength} bytes, SHA-256 ${createHash("sha256").update(bytes).digest("hex")}`,
);
