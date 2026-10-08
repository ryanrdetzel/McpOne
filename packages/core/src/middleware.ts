import type { MiddlewareHandler } from "hono";
import type { Logger } from "./log";

declare module "hono" {
  interface ContextVariableMap {
    reqId: string;
  }
}

/** HEAD responses preserve status/headers, but never expose a response body. */
export const headStrip: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method === "HEAD" && c.res.body) {
    c.res = new Response(null, {
      status: c.res.status,
      headers: c.res.headers,
    });
  }
};

export function createRequestContext(log: Logger): MiddlewareHandler {
  return async (c, next) => {
    const reqId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("reqId", reqId);
    const start = performance.now();
    await next();
    // Auth and asset responses can carry immutable fetch headers.
    c.header("x-request-id", reqId);
    log.info({
      msg: "request",
      req_id: reqId,
      route: c.req.routePath,
      method: c.req.method,
      status: c.res.status,
      dur_ms: Math.round(performance.now() - start),
    });
  };
}
