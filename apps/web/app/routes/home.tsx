import {
  Activity,
  ArrowUpRight,
  Blocks,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  Database,
  FileJson,
  LayoutDashboard,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useRevalidator } from "react-router";
import { client } from "../api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import type { Route } from "./+types/home";

export async function clientLoader() {
  try {
    const response = await client.api.dashboard.$get();
    const status = await response.json();
    return {
      status,
      error: response.ok
        ? null
        : "The database probe failed. Check the API logs and your database connection.",
    };
  } catch {
    return {
      status: null,
      error:
        "The API is unavailable. Check the server and refresh to reconnect.",
    };
  }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { status, error } = loaderData;
  const revalidator = useRevalidator();
  const refreshing = revalidator.state !== "idle";

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">
            <Blocks size={21} />
          </span>
          <span>
            McpOne<span className="brand-subtitle">TOOL CONTROL PLANE</span>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">M</span>
          <div>
            McpOne workspace<small>Cloudflare Workers + D1</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Dashboard navigation">
          <a href="#overview" className="nav-item active">
            <LayoutDashboard size={18} />
            Overview
            <ChevronRight size={15} className="ml-auto" />
          </a>
          <a href="#services" className="nav-item">
            <Activity size={18} />
            Services
          </a>
          <a href="#developer" className="nav-item">
            <Code2 size={18} />
            Developer resources
          </a>
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" />
          Workers + D1<small>Single-origin service</small>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="topbar">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            Workspace
            <ChevronRight size={14} />
            <span className="text-foreground">Overview</span>
          </div>
          <span className="environment-label">WORKERS · D1</span>
        </header>
        <main id="overview" className="dashboard-main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">WORKSPACE OVERVIEW</p>
              <h1>Tool Control Plane</h1>
              <p className="text-muted-foreground">
                Your workspace for building and operating tool infrastructure.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => revalidator.revalidate()}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Checking…" : "Refresh status"}
            </Button>
          </div>

          {error && (
            <div role="alert" className="error-banner">
              <CircleAlert size={18} />
              <span>{error}</span>
            </div>
          )}

          <div id="services" className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent>
                <div className="metric-label">
                  <span>API service</span>
                  <Server size={18} />
                </div>
                <div className="metric-value">
                  {status ? "Online" : "Unavailable"}
                </div>
                <p className="metric-note">
                  <span className={`status-dot ${status ? "" : "offline"}`} />
                  Hono · same-origin API
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <div className="metric-label">
                  <span>Database</span>
                  <Database size={18} />
                </div>
                <div className="metric-value">
                  {status?.database ? "Connected" : "Unavailable"}
                </div>
                <p className="metric-note">
                  <span
                    className={`status-dot ${status?.database ? "" : "offline"}`}
                  />
                  D1 · Drizzle migrations
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <div className="metric-label">
                  <span>Running release</span>
                  <Code2 size={18} />
                </div>
                <div className="metric-value font-mono text-2xl!">
                  {status?.release ?? "—"}
                </div>
                <p className="metric-note">
                  {status?.appSlug ?? "No API response"}
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.5fr_1fr]">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <h2>Workspace foundation</h2>
                  <span className="tag">SCAFFOLD</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  The stack is ready. Product configuration comes next.
                </p>
              </CardHeader>
              <CardContent>
                <div className="empty-state">
                  <span className="empty-icon">
                    <Blocks size={30} />
                  </span>
                  <h3>Start with a clean control plane</h3>
                  <p>
                    No tool catalog or integrations have been configured. This
                    dashboard shows live infrastructure status, not sample
                    product data.
                  </p>
                  <Button asChild variant="outline">
                    <a href="/openapi.json" target="_blank" rel="noreferrer">
                      <FileJson />
                      Inspect API contract
                      <ArrowUpRight />
                    </a>
                  </Button>
                </div>
                <div className="scope-note">
                  <BookOpen size={18} />
                  <p>
                    <strong>PRD access needed</strong>
                    <br />
                    The linked Notion PRD requires sign-in. Product screens and
                    workflows are not implemented yet; their requirements need
                    to be available before this can match the PRD.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <h2>Cloudflare-native stack</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  One service. One origin. Shared contracts.
                </p>
              </CardHeader>
              <CardContent>
                <ul className="stack-list">
                  {[
                    ["Frontend", "React Router 7 · React · Vite"],
                    ["Components", "Tailwind CSS · shadcn/ui primitives"],
                    ["Backend", "Workers · Hono · RPC · OpenAPI"],
                    ["Data", "D1 · Drizzle · Zod"],
                    ["Authentication", "Better Auth · organizations"],
                    ["Tooling", "pnpm · TypeScript · Biome · Vitest"],
                  ].map(([name, detail]) => (
                    <li key={name}>
                      <span className="stack-check">
                        <Check size={14} />
                      </span>
                      <div>
                        <strong>{name}</strong>
                        <small>{detail}</small>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="auth-note">
                  <ShieldCheck size={18} />
                  <p>
                    Organization-aware authentication is included in the
                    backend. This status dashboard does not expose account data.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card id="developer" className="mt-6">
            <CardHeader>
              <h2>Developer resources</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Real endpoints and the directories you’ll work in.
              </p>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                {[
                  ["/healthz", "Service health"],
                  ["/db", "Database probe"],
                  ["/openapi.json", "Generated OpenAPI contract"],
                ].map(([path, label]) => (
                  <a
                    className="resource-link"
                    key={path}
                    href={path}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>
                      <strong>{label}</strong>
                      <code>{path}</code>
                    </span>
                    <ArrowUpRight size={17} />
                  </a>
                ))}
              </div>
              <div className="directory-panel">
                <div className="flex items-center gap-2 mb-3 text-muted-foreground">
                  <Terminal size={17} />
                  <span className="text-xs font-medium uppercase tracking-wider">
                    Workspace layout
                  </span>
                </div>
                <dl>
                  {[
                    ["apps/web", "Dashboard & UI"],
                    ["apps/worker", "Cloudflare bindings & assets"],
                    ["packages/core", "API, auth & authorization"],
                    ["packages/database", "D1 access & migrations"],
                    ["packages/schema", "Shared contracts & tables"],
                    ["packages/config", "Validated environment"],
                  ].map(([directory, purpose]) => (
                    <div key={directory}>
                      <dt>{directory}</dt>
                      <dd>{purpose}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </CardContent>
          </Card>
          <footer className="page-footer">
            <span>McpOne · Tool Control Plane</span>
            <span>Live service probes · refresh on demand</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
