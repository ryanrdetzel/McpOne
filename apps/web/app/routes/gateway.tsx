import {
  type PolicyDecision as Decision,
  PolicyDecision,
} from "@scaffold/schema/execution";
import { GatewayState } from "@scaffold/schema/gateway";
import {
  IntegrationDraft,
  ProfileView,
  Publication,
  PublishIntegrationInput,
  type ReviewReportDocument as Review,
  ReviewReportDocument,
} from "@scaffold/schema/integrations";
import { ArrowLeft, Blocks, Copy, RefreshCw, ShieldCheck } from "lucide-react";
import {
  Children,
  cloneElement,
  type FormEvent,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { controlClient } from "../api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";

type State = ReturnType<typeof GatewayState.parse>;
type Session = {
  user: { id: string; name: string };
  session: { activeOrganizationId?: string | null };
};
type Organization = { id: string; name: string };
type RunsResponse = Awaited<
  ReturnType<Awaited<ReturnType<typeof controlClient.runs.$get>>["json"]>
>;
type Run = Extract<RunsResponse, unknown[]>[number];
type Pending = {
  connection: State["connections"][number];
  profile: State["profiles"][number];
  report: Review;
  selected: Record<string, Decision>;
};
const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-2 focus:outline-primary";
const control = "/api/control";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function responseData(response: Response): Promise<unknown> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail =
      object(data) &&
      object(data.error) &&
      typeof data.error.message === "string"
        ? data.error.message
        : object(data) && typeof data.message === "string"
          ? data.message
          : "The request could not be completed.";
    const hint =
      response.status === 401
        ? "Sign in again."
        : response.status === 403
          ? "Select a workspace where you are the owner."
          : response.status === 409
            ? "Refresh and review the latest state before retrying."
            : response.status === 429
              ? "Wait before retrying (rate limited)."
              : "";
    throw new RequestError(
      response.status,
      `${response.status}: ${detail} ${hint}`,
    );
  }
  return data;
}
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  return responseData(
    await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid gap-2 text-sm font-medium">
      {label}
      {Children.map(children, (child) =>
        isValidElement<{ id?: string }>(child) &&
        (child.type === "input" || child.type === "select")
          ? cloneElement(child, { id })
          : child,
      )}
    </label>
  );
}
function Panel({
  title,
  children,
  subtitle,
}: {
  title: string;
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export default function Gateway() {
  const [session, setSession] = useState<Session | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [state, setState] = useState<State | null>(null);
  const [profileId, setProfileId] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [inspected, setInspected] = useState<Run | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [bearer, setBearer] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signup, setSignup] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);
  const profile = state?.profiles.find((item) => item.profileId === profileId);
  const clearContext = useCallback(() => {
    epoch.current++;
    setPending(null);
    setToken(null);
    setBearer("");
    setInspected(null);
    setNotice("");
  }, []);
  const loadGateway = useCallback(async (selectId?: string) => {
    const current = epoch.current;
    const next = GatewayState.parse(await request(`${control}/gateway`));
    const response = await controlClient.runs.$get();
    if (!response.ok) await responseData(response.clone());
    const nextRuns = await response.json();
    if (!Array.isArray(nextRuns)) throw new Error("Unable to load Runs.");
    if (current !== epoch.current) return;
    setState(next);
    setRuns(nextRuns);
    setProfileId(
      (previous) =>
        selectId ??
        (next.profiles.some((item) => item.profileId === previous)
          ? previous
          : (next.profiles[0]?.profileId ?? "")),
    );
  }, []);
  const loadSession = useCallback(async () => {
    const data = await request("/api/auth/get-session");
    if (
      !object(data) ||
      !object(data.user) ||
      typeof data.user.id !== "string" ||
      typeof data.user.name !== "string" ||
      !object(data.session)
    ) {
      clearContext();
      setSession(null);
      setState(null);
      setRuns([]);
      setOrganizations([]);
      setProfileId("");
      return;
    }
    const active =
      typeof data.session.activeOrganizationId === "string"
        ? data.session.activeOrganizationId
        : null;
    clearContext();
    setSession({
      user: { id: data.user.id, name: data.user.name },
      session: { activeOrganizationId: active },
    });
    const orgs = await request("/api/auth/organization/list");
    if (!Array.isArray(orgs)) throw new Error("Invalid workspace response.");
    setOrganizations(
      orgs.flatMap((item: unknown) =>
        object(item) &&
        typeof item.id === "string" &&
        typeof item.name === "string"
          ? [{ id: item.id, name: item.name }]
          : [],
      ),
    );
    if (active) await loadGateway();
    else setState(null);
  }, [clearContext, loadGateway]);
  const act = useCallback(
    async (action: () => Promise<void>) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await action();
      } catch (cause) {
        if (
          cause instanceof RequestError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          clearContext();
          setState(null);
          setRuns([]);
          if (cause.status === 401) {
            setSession(null);
            setOrganizations([]);
            setProfileId("");
          }
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Unexpected request failure.",
        );
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [clearContext],
  );
  useEffect(() => {
    void act(loadSession);
    return () => {
      epoch.current++;
    };
  }, [act, loadSession]);
  function form(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return new FormData(event.currentTarget);
  }
  async function review(
    connection: State["connections"][number],
    draftRevisionId: string,
  ) {
    if (!profile) throw new Error("Select a Profile before reviewing tools.");
    const report = ReviewReportDocument.parse(
      await request(
        `${control}/integrations/${connection.integrationId}/validate`,
        { draftRevisionId },
      ),
    );
    const selected: Record<string, Decision> = {};
    for (const tool of report.accepted)
      if (profile?.tools.includes(tool.name))
        selected[tool.name] =
          profile.policies.find((policy) => policy.pattern === tool.name)
            ?.decision ?? "ask";
    setPending({ connection, profile, report, selected });
  }
  async function publish() {
    if (!pending || !profile || pending.profile.profileId !== profile.profileId)
      return;
    const reviewedProfile = pending.profile;
    const prefix = `${pending.connection.slug}.`;
    const tools = Object.keys(pending.selected);
    const policies = [
      ...reviewedProfile.policies.filter(
        (rule) =>
          rule.pattern.startsWith(prefix) &&
          !Object.hasOwn(pending.selected, rule.pattern),
      ),
      ...Object.entries(pending.selected).map(([pattern, decision]) => ({
        pattern,
        decision,
      })),
    ];
    const bindings = Object.fromEntries(
      Object.entries(reviewedProfile.bindings).filter(([key]) =>
        key.startsWith(prefix),
      ),
    );
    const input = PublishIntegrationInput.parse({
      draftRevisionId: pending.report.draftRevisionId,
      reportDigest: pending.report.reportDigest,
      expectedCurrentRevisionId: pending.connection.currentRevisionId,
      profiles: [
        {
          profileId: reviewedProfile.profileId,
          expectedRevision: reviewedProfile.revision,
          tools,
          bindings,
          policies,
        },
      ],
    });
    Publication.parse(
      await request(
        `${control}/integrations/${pending.connection.integrationId}/publish`,
        input,
      ),
    );
    setPending(null);
    await loadGateway();
    setNotice(
      "Review published atomically. Other servers' tools and bindings were preserved.",
    );
  }
  const endpoint = profile
    ? `${typeof window === "undefined" ? "" : window.location.origin}/mcp/${profile.profileId}`
    : "";
  const config = JSON.stringify(
    {
      mcpServers: {
        McpOne: {
          url: endpoint,
          headers: { Authorization: `Bearer ${token ?? "<YOUR_GRANT_TOKEN>"}` },
        },
      },
    },
    null,
    2,
  );
  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setNotice("Copied to clipboard.");
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="topbar">
        <a href="/" className="flex items-center gap-2 font-semibold">
          <ArrowLeft size={16} />
          <Blocks size={20} /> McpOne
        </a>
        <span className="environment-label">MCP GATEWAY</span>
        {session && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                clearContext();
                await request("/api/auth/sign-out", {});
                setSession(null);
                setState(null);
                setRuns([]);
                setOrganizations([]);
                setProfileId("");
              })
            }
          >
            Sign out
          </Button>
        )}
      </header>
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">YOUR TOOLS, ONE ENDPOINT</p>
            <h1 className="text-3xl font-semibold">MCP Gateway</h1>
            <p className="mt-2 text-muted-foreground">
              Connect servers. Review tools. Publish only what your clients
              should see.
            </p>
          </div>
          {session && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  clearContext();
                  await loadSession();
                })
              }
            >
              <RefreshCw />
              Refresh
            </Button>
          )}
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
          >
            {notice}
          </p>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            Working…
          </p>
        )}
        {!session ? (
          <div className="mx-auto max-w-md">
            <Panel
              title={
                signup
                  ? "Create your owner account"
                  : "Sign in to your workspace"
              }
              subtitle="Your session stays in a same-origin cookie. No credentials are persisted by this page."
            >
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  const data = form(event);
                  const password = String(data.get("password") ?? "");
                  event.currentTarget.reset();
                  void act(async () => {
                    clearContext();
                    await request(
                      `/api/auth/${signup ? "sign-up" : "sign-in"}/email`,
                      {
                        email: data.get("email"),
                        password,
                        ...(signup ? { name: data.get("name") } : {}),
                      },
                    );
                    await loadSession();
                  });
                }}
              >
                <fieldset disabled={busy} className="space-y-4">
                  {signup && (
                    <Field label="Name">
                      <input
                        className={inputClass}
                        name="name"
                        autoComplete="name"
                        required
                      />
                    </Field>
                  )}
                  <Field label="Email">
                    <input
                      className={inputClass}
                      name="email"
                      type="email"
                      autoComplete="username"
                      required
                    />
                  </Field>
                  <Field label="Password">
                    <input
                      className={inputClass}
                      name="password"
                      type="password"
                      autoComplete={
                        signup ? "new-password" : "current-password"
                      }
                      minLength={8}
                      required
                    />
                  </Field>
                  <Button type="submit">
                    {signup ? "Create account" : "Sign in"}
                  </Button>
                </fieldset>
              </form>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setSignup(!signup)}
              >
                {signup
                  ? "Already have an account? Sign in"
                  : "New here? Create an account"}
              </Button>
            </Panel>
          </div>
        ) : (
          <>
            <Panel
              title="Workspace & Profile"
              subtitle={`Signed in as ${session.user.name}. Workspace creation is an explicit choice.`}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Active workspace">
                  <select
                    className={inputClass}
                    disabled={busy}
                    value={session.session.activeOrganizationId ?? ""}
                    onChange={(event) => {
                      const organizationId = event.target.value;
                      clearContext();
                      setState(null);
                      setRuns([]);
                      setProfileId("");
                      void act(async () => {
                        await request("/api/auth/organization/set-active", {
                          organizationId,
                        });
                        await loadSession();
                      });
                    }}
                  >
                    <option value="" disabled>
                      Select a workspace
                    </option>
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    const data = form(event);
                    event.currentTarget.reset();
                    void act(async () => {
                      clearContext();
                      const result = await request(
                        "/api/auth/organization/create",
                        { name: data.get("name"), slug: data.get("slug") },
                      );
                      if (!object(result) || typeof result.id !== "string")
                        throw new Error("Invalid workspace creation response.");
                      await request("/api/auth/organization/set-active", {
                        organizationId: result.id,
                      });
                      setProfileId("");
                      await loadSession();
                    });
                  }}
                >
                  <fieldset
                    disabled={busy}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <Field label="New workspace name">
                      <input
                        className={inputClass}
                        name="name"
                        required
                        maxLength={100}
                      />
                    </Field>
                    <Field label="Workspace slug">
                      <input
                        className={inputClass}
                        name="slug"
                        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                        required
                      />
                    </Field>
                    <Button type="submit">Create workspace</Button>
                  </fieldset>
                </form>
              </div>
              {state && (
                <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                  <Field label="Profile">
                    <select
                      className={inputClass}
                      value={profileId}
                      disabled={busy}
                      onChange={(event) => {
                        clearContext();
                        setProfileId(event.target.value);
                      }}
                    >
                      <option value="" disabled>
                        Select a Profile
                      </option>
                      {state.profiles.map((item) => (
                        <option key={item.profileId} value={item.profileId}>
                          {item.label} · {item.tools.length} tools
                        </option>
                      ))}
                    </select>
                  </Field>
                  <form
                    onSubmit={(event) => {
                      const data = form(event);
                      event.currentTarget.reset();
                      void act(async () => {
                        clearContext();
                        const result = ProfileView.parse(
                          await request(`${control}/gateway/profiles`, {
                            label: data.get("label"),
                          }),
                        );
                        await loadGateway(result.profileId);
                      });
                    }}
                  >
                    <fieldset disabled={busy} className="flex items-end gap-2">
                      <Field label="New Profile label">
                        <input
                          className={inputClass}
                          name="label"
                          required
                          maxLength={100}
                        />
                      </Field>
                      <Button type="submit">Create Profile</Button>
                    </fieldset>
                  </form>
                </div>
              )}
              {state?.profiles.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Create an empty Profile to choose the tools exposed at its MCP
                  endpoint.
                </p>
              )}
            </Panel>
            {state && (
              <div className="grid items-start gap-6 lg:grid-cols-2">
                <div className="space-y-6">
                  <Panel
                    title="Connect an MCP server"
                    subtitle="HTTPS servers with no authentication or an existing bearer token. Generic OAuth is not available yet."
                  >
                    <form
                      className="space-y-4"
                      onSubmit={(event) => {
                        const data = form(event);
                        const bearerToken = bearer;
                        setBearer("");
                        event.currentTarget.reset();
                        void act(async () => {
                          const result = IntegrationDraft.parse(
                            await request(`${control}/gateway/connections`, {
                              slug: data.get("slug"),
                              displayName: data.get("displayName"),
                              endpoint: data.get("endpoint"),
                              ...(bearerToken ? { bearerToken } : {}),
                            }),
                          );
                          await loadGateway();
                          const fresh = GatewayState.parse(
                            await request(`${control}/gateway`),
                          );
                          const connection = fresh.connections.find(
                            (item) =>
                              item.integrationId === result.integrationId,
                          );
                          if (!connection)
                            throw new Error(
                              "Connection could not be reloaded.",
                            );
                          if (profile)
                            await review(connection, result.draftRevisionId);
                          else
                            setNotice(
                              "Server saved. Select a Profile, then review its tools.",
                            );
                        });
                      }}
                    >
                      <fieldset
                        disabled={busy || !profile || !!pending}
                        className="space-y-4"
                      >
                        <Field label="Display name">
                          <input
                            className={inputClass}
                            name="displayName"
                            required
                            maxLength={128}
                            placeholder="Documentation server"
                          />
                        </Field>
                        <Field label="Tool namespace">
                          <input
                            className={inputClass}
                            name="slug"
                            required
                            pattern="[a-z][a-z0-9_]{0,63}"
                            placeholder="docs"
                          />
                          <span className="text-xs text-muted-foreground">
                            Unique server prefix, e.g. docs.search. Lowercase
                            letters, numbers and underscores.
                          </span>
                        </Field>
                        <Field label="HTTPS MCP endpoint">
                          <input
                            className={inputClass}
                            type="url"
                            name="endpoint"
                            required
                            pattern="https://.*"
                            placeholder="https://example.com/mcp"
                          />
                        </Field>
                        <Field label="Bearer token (optional)">
                          <input
                            className={inputClass}
                            type="password"
                            autoComplete="off"
                            value={bearer}
                            onChange={(event) => setBearer(event.target.value)}
                            placeholder="Leave blank for a public server"
                          />
                        </Field>
                        <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                          <ShieldCheck className="mb-2" size={18} />
                          The token is encrypted, scoped to this workspace and
                          bound to this exact HTTPS endpoint. Publishing
                          explicitly shares its use with the selected Profile's
                          clients. It is not a verified Provider Account and is
                          never shown again.
                        </p>
                        <Button type="submit">
                          Save server & discover tools
                        </Button>
                      </fieldset>
                    </form>
                    {!profile && (
                      <p className="text-sm text-muted-foreground">
                        Select or create a Profile first.
                      </p>
                    )}
                  </Panel>
                  <Panel
                    title="Connected servers"
                    subtitle="Disabling a server restricts all its published tools; rediscovery requires a new review."
                  >
                    {state.connections.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No servers connected yet.
                      </p>
                    ) : (
                      state.connections.map((connection) => (
                        <div
                          key={connection.integrationId}
                          className="space-y-2 rounded-lg border border-border p-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="font-semibold">
                              {connection.displayName}
                            </h3>
                            <span className="text-xs text-muted-foreground">
                              {connection.enabled ? "Enabled" : "Disabled"} ·{" "}
                              {connection.authentication}
                            </span>
                          </div>
                          <p className="break-all text-sm text-muted-foreground">
                            {connection.endpoint}
                          </p>
                          <p className="text-xs">
                            Namespace: <code>{connection.slug}</code> ·{" "}
                            {connection.currentRevisionId
                              ? "Published"
                              : "Unpublished"}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || !!pending}
                              onClick={() =>
                                void act(async () => {
                                  await request(
                                    `${control}/integrations/${connection.integrationId}`,
                                    { enabled: !connection.enabled },
                                    "PATCH",
                                  );
                                  await loadGateway();
                                })
                              }
                            >
                              {connection.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || !profile || !!pending}
                              onClick={() =>
                                void act(async () => {
                                  const draft = IntegrationDraft.parse(
                                    await request(
                                      `${control}/integrations/${connection.integrationId}/refresh`,
                                      {},
                                    ),
                                  );
                                  await loadGateway();
                                  await review(
                                    connection,
                                    draft.draftRevisionId,
                                  );
                                })
                              }
                            >
                              Rediscover & review
                            </Button>
                            {connection.draftRevisionId && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !profile || !!pending}
                                onClick={() =>
                                  void act(async () => {
                                    await review(
                                      connection,
                                      connection.draftRevisionId!,
                                    );
                                  })
                                }
                              >
                                Review saved draft
                              </Button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </Panel>
                </div>
                <div className="space-y-6">
                  {pending && profile && (
                    <Panel
                      title={`Review: ${pending.connection.displayName}`}
                      subtitle={`Publishing to ${profile.label}. No tools are selected automatically. Ask requires owner approval before execution.`}
                    >
                      <p className="text-xs break-all text-muted-foreground">
                        Immutable review digest: {pending.report.reportDigest}
                      </p>
                      <fieldset disabled={busy} className="space-y-3">
                        {pending.report.accepted.length === 0 && (
                          <p>No tools accepted.</p>
                        )}
                        {pending.report.accepted.map((tool) => (
                          <div
                            key={tool.name}
                            className="rounded-lg border border-border p-3"
                          >
                            <label className="flex items-start gap-3">
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={Object.hasOwn(
                                  pending.selected,
                                  tool.name,
                                )}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setPending((previous) => {
                                    if (!previous) return previous;
                                    const selected = { ...previous.selected };
                                    if (checked) selected[tool.name] = "ask";
                                    else delete selected[tool.name];
                                    return { ...previous, selected };
                                  });
                                }}
                              />
                              <span className="min-w-0">
                                <strong className="break-all text-sm">
                                  {tool.name}
                                </strong>
                                <span className="mt-1 block text-sm text-muted-foreground">
                                  {tool.description}
                                </span>
                              </span>
                            </label>
                            <p className="mt-2 text-xs text-muted-foreground">
                              Operation: {tool.operationClass}
                            </p>
                            {Object.hasOwn(pending.selected, tool.name) && (
                              <Field label={`Policy for ${tool.name}`}>
                                <select
                                  className={inputClass}
                                  value={pending.selected[tool.name]}
                                  onChange={(event) => {
                                    const decision = PolicyDecision.parse(
                                      event.target.value,
                                    );
                                    setPending((previous) =>
                                      previous
                                        ? {
                                            ...previous,
                                            selected: {
                                              ...previous.selected,
                                              [tool.name]: decision,
                                            },
                                          }
                                        : previous,
                                    );
                                  }}
                                >
                                  <option value="ask">
                                    Ask — require owner approval
                                  </option>
                                  <option value="allow">
                                    Allow — execute without approval
                                  </option>
                                  <option value="block">
                                    Block — deny execution
                                  </option>
                                </select>
                              </Field>
                            )}
                            <details className="mt-2 text-xs">
                              <summary className="cursor-pointer">
                                Input schema
                              </summary>
                              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                                {JSON.stringify(tool.inputSchema, null, 2)}
                              </pre>
                            </details>
                          </div>
                        ))}
                        <div className="flex flex-wrap gap-2">
                          <Button onClick={() => void act(publish)}>
                            Publish {Object.keys(pending.selected).length}{" "}
                            selected tools
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => setPending(null)}
                          >
                            Discard review
                          </Button>
                        </div>
                      </fieldset>
                      <p className="text-xs text-muted-foreground">
                        Unselected tools from this server are removed from this
                        Profile. Other servers' tools, bindings and policy rules
                        are preserved. Other affected Profiles retain their
                        selections; review the impact below.
                      </p>
                      {pending.report.changes.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-sm">
                            Revision changes
                          </summary>
                          <ul className="mt-2 text-xs">
                            {pending.report.changes.map((change) => (
                              <li key={`${change.tool}-${change.kind}`}>
                                {change.tool}: {change.kind}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {pending.report.affectedProfiles.map((affected) => (
                        <p className="text-xs" key={affected.profileId}>
                          Affected Profile:{" "}
                          {state.profiles.find(
                            (item) => item.profileId === affected.profileId,
                          )?.label ?? affected.profileId}{" "}
                          · revision {affected.revision} · {affected.grantCount}{" "}
                          grants · {affected.tools.join(", ")}
                        </p>
                      ))}
                      {pending.report.rejected.length > 0 && (
                        <div>
                          <h3 className="font-semibold">Rejected tools</h3>
                          {pending.report.rejected.map((item) => (
                            <p
                              className="mt-2 text-sm text-muted-foreground"
                              key={`${item.upstreamName}:${item.path}:${item.code}`}
                            >
                              {item.upstreamName}: {item.code} — {item.message}
                            </p>
                          ))}
                        </div>
                      )}
                      {pending.report.diagnostics?.map((item) => (
                        <pre
                          key={`${item.upstreamName}:${item.path}:${item.code}`}
                          className="overflow-auto whitespace-pre-wrap text-xs"
                        >
                          {JSON.stringify(item, null, 2)}
                        </pre>
                      ))}
                    </Panel>
                  )}
                  <Panel
                    title={
                      profile
                        ? `${profile.label}: published tools`
                        : "Published tools"
                    }
                    subtitle="The stable endpoint exposes the selected namespaced tools from every published server."
                  >
                    {profile ? (
                      <>
                        <Field label="MCP endpoint">
                          <input
                            className={inputClass}
                            readOnly
                            value={endpoint}
                          />
                        </Field>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void act(() => copy(endpoint))}
                        >
                          <Copy />
                          Copy endpoint
                        </Button>
                        {profile.tools.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No tools published. Discover a server and explicitly
                            select its tools.
                          </p>
                        ) : (
                          <ul className="space-y-2">
                            {profile.tools.map((name) => (
                              <li
                                key={name}
                                className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted p-3 text-sm"
                              >
                                <code className="break-all">{name}</code>
                                <span>
                                  {profile.policies.find(
                                    (rule) => rule.pattern === name,
                                  )?.decision ?? "Policy inherited"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Profile revision {profile.revision} ·{" "}
                          {profile.enabled ? "Enabled" : "Disabled"}. Mandatory
                          workspace rules can further restrict these policies.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Select a Profile to view its endpoint and tools.
                      </p>
                    )}
                  </Panel>
                  {profile && (
                    <Panel
                      title="Client Grants"
                      subtitle="Separate tokens for each client. Tokens are shown once; revocation immediately restricts access."
                    >
                      <form
                        onSubmit={(event) => {
                          const data = form(event);
                          event.currentTarget.reset();
                          void act(async () => {
                            setToken(null);
                            const response = await controlClient.profiles[
                              ":profileId"
                            ].grants.$post({
                              param: { profileId },
                              json: { label: String(data.get("label")) },
                            });
                            if (!response.ok)
                              await responseData(response.clone());
                            const result = await response.json();
                            if (!("token" in result))
                              throw new Error("Unable to issue Grant.");
                            setToken(result.token);
                            await loadGateway();
                          });
                        }}
                      >
                        <fieldset
                          disabled={busy || !!token}
                          className="flex items-end gap-2"
                        >
                          <Field label="Client label">
                            <input
                              className={inputClass}
                              name="label"
                              required
                              maxLength={100}
                              placeholder="Desktop client"
                            />
                          </Field>
                          <Button type="submit">Issue Grant</Button>
                        </fieldset>
                      </form>
                      {token && (
                        <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
                          <h3 className="font-semibold">Save this token now</h3>
                          <p className="text-sm">
                            This is the only reveal. Keep it private; anyone
                            holding it can use this Profile.
                          </p>
                          <Field label="New Grant token">
                            <input
                              className={`${inputClass} font-mono`}
                              readOnly
                              value={token}
                              autoComplete="off"
                            />
                          </Field>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void act(() => copy(token))}
                            >
                              <Copy />
                              Copy token
                            </Button>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void act(() => copy(config))}
                            >
                              Copy client config
                            </Button>
                            <Button
                              disabled={busy}
                              onClick={() => setToken(null)}
                            >
                              I've saved it — dismiss
                            </Button>
                          </div>
                        </div>
                      )}
                      <details>
                        <summary className="cursor-pointer text-sm">
                          Streamable HTTP client configuration
                        </summary>
                        <pre className="mt-3 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                          {config}
                        </pre>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Use a client supporting MCP Streamable HTTP and
                          Authorization headers. Replace the placeholder with
                          your Grant token.
                        </p>
                      </details>
                      {profile.grants.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No Grants issued.
                        </p>
                      ) : (
                        profile.grants.map((grant) => (
                          <div
                            className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"
                            key={grant.grantId}
                          >
                            <div className="text-sm">
                              <strong>{grant.label}</strong>
                              <p className="text-xs text-muted-foreground">
                                {grant.revoked
                                  ? "Revoked"
                                  : grant.expiresAt
                                    ? `Expires ${new Date(grant.expiresAt).toLocaleString()}`
                                    : "No expiry"}
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || grant.revoked}
                              onClick={() =>
                                void act(async () => {
                                  await request(
                                    `${control}/grants/${grant.grantId}`,
                                    undefined,
                                    "DELETE",
                                  );
                                  setToken(null);
                                  await loadGateway();
                                })
                              }
                            >
                              Revoke
                            </Button>
                          </div>
                        ))
                      )}
                    </Panel>
                  )}
                </div>
              </div>
            )}
            {state && (
              <Panel
                title="Runs & owner approvals"
                subtitle="Ask policies pause real client requests here. Refresh to see queued work and final outcomes."
              >
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await loadGateway();
                      })
                    }
                  >
                    <RefreshCw />
                    Refresh Runs
                  </Button>
                </div>
                {runs.filter((run) => !profileId || run.profileId === profileId)
                  .length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No Runs for this Profile yet. Connect a client using a Grant
                    and call a published tool.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {runs
                      .filter(
                        (run) => !profileId || run.profileId === profileId,
                      )
                      .map((run) => (
                        <div
                          key={run.runId}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
                        >
                          <div className="min-w-0">
                            <h3 className="break-all font-medium">
                              {run.tool}
                            </h3>
                            <p className="text-xs text-muted-foreground">
                              {run.status} ·{" "}
                              {new Date(run.createdAt).toLocaleString()}
                              {run.deadline
                                ? ` · deadline ${new Date(run.deadline).toLocaleString()}`
                                : ""}
                            </p>
                            {run.error && (
                              <p className="mt-1 text-sm">
                                {run.error.code}: {run.error.message}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  const response = await controlClient.runs[
                                    ":runId"
                                  ].$get({ param: { runId: run.runId } });
                                  if (!response.ok)
                                    await responseData(response.clone());
                                  const result = await response.json();
                                  if ("runId" in result) setInspected(result);
                                  else
                                    throw new Error("Unable to inspect Run.");
                                })
                              }
                            >
                              Inspect
                            </Button>
                            {run.status === "pending_approval" && (
                              <>
                                {(["approve", "deny"] as const).map(
                                  (decision) => (
                                    <Button
                                      key={decision}
                                      size="sm"
                                      variant={
                                        decision === "deny"
                                          ? "outline"
                                          : "default"
                                      }
                                      disabled={busy}
                                      onClick={() =>
                                        void act(async () => {
                                          await request(
                                            `${control}/runs/${run.runId}/${decision}`,
                                            {},
                                          );
                                          await loadGateway();
                                          setInspected(null);
                                        })
                                      }
                                    >
                                      {decision === "approve"
                                        ? "Approve frozen request"
                                        : "Deny"}
                                    </Button>
                                  ),
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
                {inspected && (
                  <div className="rounded-lg bg-muted p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">Run inspection</h3>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setInspected(null)}
                      >
                        Close
                      </Button>
                    </div>
                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(inspected, null, 2)}
                    </pre>
                  </div>
                )}
              </Panel>
            )}
          </>
        )}
      </main>
    </div>
  );
}
