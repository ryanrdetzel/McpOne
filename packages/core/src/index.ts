import type { Env } from "@scaffold/config";
import type { Database } from "@scaffold/database";
import { Hono } from "hono";
import { createAuth } from "./auth";
import { createExecutionService } from "./execution/service";
import { createFlagService } from "./flags";
import { createOrgRoleGuard } from "./guard";
import { createLogger } from "./log";
import { createMcpRoutes } from "./mcp";
import { createRequestContext, headStrip } from "./middleware";
import { ApiRoutes } from "./routes";

export type Application = Hono;
export type { Authentication, AuthOptions } from "./auth";
export { createAuth } from "./auth";
export type { ControlApiType } from "./control-routes";
export type { FlagService } from "./flags";
export { createFlagService, rolloutBucket } from "./flags";
export type { ApiType } from "./routes";

/** Platform adapters provide parsed config and a database; core owns application behavior. */
export function createApplication({
  env,
  db,
  execution = createExecutionService({ db, secret: env.BETTER_AUTH_SECRET }),
}: {
  env: Env;
  db: Database;
  execution?: ReturnType<typeof createExecutionService>;
}): Application {
  const auth = createAuth({ env, db });
  const flags = createFlagService(db);
  const log = createLogger(env.RELEASE);
  const requireOrgRole = createOrgRoleGuard(auth, db);
  const app = new Hono();

  app.use("*", headStrip);
  app.use("*", createRequestContext(log));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route(
    "/",
    new ApiRoutes({ env, db, flags, requireOrgRole, execution }).api,
  );
  app.route("/mcp", createMcpRoutes(execution, env));
  app.onError((err, c) => {
    log.error({
      msg: "unhandled error",
      err,
      req_id: c.get("reqId"),
      route: c.req.routePath,
      method: c.req.method,
    });
    return c.json({ error: "internal_error" }, 500);
  });

  // No fallback: the platform adapter can register its asset-aware notFound handler.
  return app;
}
