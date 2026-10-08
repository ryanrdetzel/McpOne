import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import "./app.css";

/**
 * The document shell. SPA mode renders Layout twice: at build time around
 * HydrateFallback (that render IS index.html, which is why the shell — and
 * <Scripts/> in particular — lives here and not in Root), and at runtime
 * around the routed app.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>McpOne · Tool Control Plane</title>
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-background font-display text-foreground antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * What renders while clientLoaders resolve on first paint. SPA mode permits
 * this export only here on the root route — not on individual routes.
 */
export function HydrateFallback() {
  return (
    <div role="status" className="p-10 text-sm text-muted-foreground">
      Connecting to your workspace…
    </div>
  );
}

export default function Root() {
  return <Outlet />;
}
