import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "@scaffold/config";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export function localConfiguration() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor! < 18)
    throw new Error("Direct local runtime requires Node 22.18+");
  const configPath = process.env.LOCAL_CONFIG;
  let privateBindings: Record<string, unknown> = {};
  if (configPath) {
    const path = resolve(configPath);
    if (!path.endsWith(".secrets.json"))
      throw new Error("LOCAL_CONFIG must use an ignored *.secrets.json file");
    if ((statSync(path).mode & 0o777) !== 0o600)
      throw new Error("LOCAL_CONFIG must have mode 0600");
    privateBindings = JSON.parse(readFileSync(path, "utf8"));
  }
  const bindings = { ...privateBindings, ...process.env };
  const port = Number(bindings.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  const origin = `http://localhost:${port}`;
  const env = parseEnv({
    ...bindings,
    BETTER_AUTH_URL: bindings.BETTER_AUTH_URL ?? origin,
    TRUSTED_ORIGINS: bindings.TRUSTED_ORIGINS ?? origin,
  });
  if (
    env.BETTER_AUTH_URL !== origin ||
    env.TRUSTED_ORIGINS.length !== 1 ||
    env.TRUSTED_ORIGINS[0] !== origin
  )
    throw new Error(
      "Auth URL and trusted origin must exactly match the localhost listener port",
    );
  const databasePath = resolve(
    root,
    String(bindings.SQLITE_PATH ?? ".state/local/mcpone.sqlite"),
  );
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  return {
    env,
    port,
    origin,
    databasePath,
    assetsPath: resolve(
      root,
      String(bindings.LOCAL_ASSETS_PATH ?? "apps/web/build/client"),
    ),
  };
}
