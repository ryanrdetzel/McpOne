import { readFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const compilerPath = createRequire(
  new URL("../packages/core/package.json", import.meta.url),
).resolve("typescript");
// Bundle dependencies here: the lifecycle builder intentionally rejects pnpm's
// private .pnpm import paths, and only receives this self-contained module.
const bundleOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  conditions: ["workerd", "browser"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  loader: { ".pem": "text" },
  external: ["node:*", "cloudflare:workers", "cloudflare:sockets"],
  plugins: [
    {
      name: "typescript-browser-host",
      setup(builder) {
        builder.onLoad(
          { filter: /[\\/]typescript[\\/]lib[\\/]typescript\.js$/ },
          async (args) => {
            if (args.path !== compilerPath) return undefined;
            // TypeScript supports browser initialization through this flag. Scope
            // it to the compiler, not Workers' Node-compatible process global.
            // The real compiler remains bundled and uses our immutable host.
            const result = await transform(await readFile(args.path, "utf8"), {
              loader: "js",
              target: "es2022",
              define: { "process.browser": "true" },
            });
            return {
              contents: result.code,
              loader: "js",
              resolveDir: dirname(args.path),
            };
          },
        );
      },
    },
    {
      name: "static-wasm",
      setup(builder) {
        builder.onResolve({ filter: /\.wasm$/ }, (args) => {
          const name = args.path.split("/").at(-1);
          if (name !== "tls.wasm")
            throw new Error(
              "Only reviewed static runtime WASM modules are allowed",
            );
          return { path: `./${name}`, external: true };
        });
      },
    },
    {
      name: "node-builtins",
      setup(builder) {
        const builtins = new Set(
          builtinModules.map((name) => name.replace(/^node:/, "")),
        );
        builder.onResolve({ filter: /^(?:node:|[a-z])/ }, (args) => {
          if (builtins.has(args.path.replace(/^node:/, ""))) {
            return {
              path: `node:${args.path.replace(/^node:/, "")}`,
              external: true,
            };
          }
          return undefined;
        });
      },
    },
  ],
  nodePaths: [resolve(root, "node_modules")],
};

await build({
  ...bundleOptions,
  entryPoints: ["apps/worker/src/index.ts"],
  outfile: "apps/worker/dist/index.js",
});
