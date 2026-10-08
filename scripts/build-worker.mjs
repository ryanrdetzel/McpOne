import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
// Bundle dependencies here: the lifecycle builder intentionally rejects pnpm's
// private .pnpm import paths, and only receives this self-contained module.
await build({
  absWorkingDir: root,
  entryPoints: ["apps/worker/src/index.ts"],
  outfile: "apps/worker/dist/index.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  conditions: ["workerd", "browser"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["node:*", "cloudflare:workers", "cloudflare:sockets"],
  plugins: [
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
});
