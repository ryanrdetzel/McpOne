import type { D1Database } from "@cloudflare/workers-types";
import { parseEnv } from "@scaffold/config";
import { type Application, createApplication } from "@scaffold/core";
import { createDatabase } from "@scaffold/database";

/** Only the standard fetch surface is used; core retains portable Web API types. */
interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

interface Bindings extends Record<string, unknown> {
  DB: D1Database;
  ASSETS: AssetBinding;
}

const applications = new WeakMap<Bindings, Application>();
const servicePath =
  /^(?:\/api(?:\/|$)|\/admin(?:\/|$)|\/healthz(?:\/|$)|\/db(?:\/|$)|\/openapi\.json(?:\/|$))/;

function application(bindings: Bindings) {
  let app = applications.get(bindings);
  if (app) return app;
  app = createApplication({
    env: parseEnv(bindings),
    db: createDatabase(bindings.DB),
  });
  app.notFound(async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    if (
      !["GET", "HEAD"].includes(request.method) ||
      servicePath.test(url.pathname)
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    let response = await bindings.ASSETS.fetch(request);
    if (response.status === 404) {
      url.pathname = "/index.html";
      response = await bindings.ASSETS.fetch(new Request(url, request));
    }
    const headers = new Headers(response.headers);
    if (response.ok) {
      headers.set(
        "Cache-Control",
        url.pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
  applications.set(bindings, app);
  return app;
}

export default {
  fetch(request: Request, bindings: Bindings) {
    return application(bindings).fetch(request);
  },
};
