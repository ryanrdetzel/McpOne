import { createApplication } from "@scaffold/core";
import { type Bindings, runtime } from "./runtime";

export { ControlScheduler } from "./control-scheduler";

const servicePath =
  /^(?:\/api(?:\/|$)|\/admin(?:\/|$)|\/mcp(?:\/|$)|\/healthz(?:\/|$)|\/db(?:\/|$)|\/openapi\.json(?:\/|$))/;

function application(bindings: Bindings) {
  const context = runtime(bindings);
  if (context.app) return context.app;
  const app = createApplication(context);
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
  context.app = app;
  return app;
}

export default {
  async fetch(request: Request, bindings: Bindings) {
    const namespace = bindings.CONTROL_SCHEDULER;
    const scheduler = namespace.get(namespace.idFromName("execution-loop"));
    await scheduler.ensureScheduled();
    return application(bindings).fetch(request);
  },
};
