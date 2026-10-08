import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

/**
 * Build-time only. In SPA mode (ssr:false) this runs once, during
 * `react-router build`, to prerender index.html — no server ships it. It exists
 * so the toolchain doesn't demand @react-router/node + isbot in `dependencies`
 * (the default entry resolver reads only that field, and auto-adds a floating
 * isbot@^5 — both blueprint violations).
 *
 * It MUST stream. `<Scripts/>` always emits the hydration bootstrap that opens
 * `window.__reactRouterContext.stream`, and the inline scripts that feed and
 * CLOSE that stream are flushed as the render completes. Synchronous
 * `renderToString` returns before any of them exist, so it emits a shell whose
 * client waits forever on a stream nothing will ever write to: hydration hangs,
 * the suspense boundary lands errored (`<!--$!-->`), and the page renders blank
 * with no console error to explain it. That shipped in 0.7.0.
 *
 * `onAllReady` (not `onShellReady`) is what makes a bot sniffer unnecessary:
 * a prerender wants the complete document, never a shell plus a live stream.
 */
export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  return new Promise<Response>((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        onAllReady() {
          const body = new PassThrough();
          const chunks: Buffer[] = [];
          body.on("data", (c: Buffer) => chunks.push(c));
          body.on("end", () => {
            responseHeaders.set("Content-Type", "text/html");
            // No manual doctype: rendering a full <html> tree, React emits its
            // own. Prepending one here is what produced a doubled doctype.
            resolve(
              new Response(Buffer.concat(chunks).toString("utf8"), {
                status: responseStatusCode,
                headers: responseHeaders,
              }),
            );
          });
          body.on("error", reject);
          pipe(body);
        },
        onError(error) {
          reject(error);
        },
      },
    );
    // A prerender that hangs must fail the build, not emit a broken shell.
    setTimeout(abort, 10_000);
  });
}
