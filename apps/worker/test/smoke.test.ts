import { DashboardStatus } from "@scaffold/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

/** Real Worker + D1 behavior; run only against an isolated local/preview database. */
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ORIGIN = { origin: BASE, "content-type": "application/json" };

async function waitForBoot(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`app did not become healthy at ${BASE}`);
}

beforeAll(() => waitForBoot());

describe("Worker smoke suite", () => {
  it("boots and serves /healthz", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("reaches the database (migrations applied)", async () => {
    const res = await fetch(`${BASE}/db`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("answers HEAD without a body", async () => {
    const res = await fetch(`${BASE}/healthz`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("echoes req_id so client errors correlate to server logs", async () => {
    const res = await fetch(`${BASE}/healthz`, {
      headers: { "x-request-id": "smoke-req-id" },
    });
    expect(res.headers.get("x-request-id")).toBe("smoke-req-id");
  });

  it("serves an OpenAPI spec matching its registered routes", async () => {
    const res = await fetch(`${BASE}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = z
      .object({ paths: z.record(z.string(), z.unknown()) })
      .parse(await res.json());
    for (const p of ["/healthz", "/db", "/api/dashboard", "/admin/flags"]) {
      expect(Object.keys(spec.paths)).toContain(p);
    }
  });

  it("reports real scaffold status without user or product data", async () => {
    const res = await fetch(`${BASE}/api/dashboard`);
    expect(res.status).toBe(200);
    const status = DashboardStatus.parse(await res.json());
    expect(status).toEqual({
      appSlug: process.env.APP_SLUG ?? "mcpone",
      release: expect.any(String),
      database: true,
    });
  });

  it("completes an auth round-trip: sign-up, session, sign-in, bad password", async () => {
    const email = `smoke-${Date.now()}@example.com`;
    const password = "correct-horse-battery-staple";

    const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ name: "Smoke", email, password }),
    });
    expect(signUp.status).toBe(200);
    z.object({ user: z.object({ id: z.uuid() }) }).parse(await signUp.json());
    const cookie = signUp.headers.get("set-cookie")?.split(";")[0] ?? "";

    const session = await fetch(`${BASE}/api/auth/get-session`, {
      headers: { cookie },
    });
    const sessionBody = z
      .object({ user: z.object({ email: z.email() }) })
      .parse(await session.json());
    expect(sessionBody.user.email).toBe(email);

    const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status).toBe(200);

    const bad = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ email, password: "wrong" }),
    });
    expect(bad.status).toBe(401);
  });

  it("supports multiple organizations per user with an active-org session", async () => {
    const email = `smoke-org-${Date.now()}@example.com`;
    const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({
        name: "Org Smoke",
        email,
        password: "correct-horse-battery-staple",
      }),
    });
    const cookie = signUp.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authed = { ...ORIGIN, cookie };
    const stamp = Date.now();

    for (const slug of [`alpha-${stamp}`, `beta-${stamp}`]) {
      const res = await fetch(`${BASE}/api/auth/organization/create`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ name: slug, slug }),
      });
      expect(res.status).toBe(200);
    }

    const list = await fetch(`${BASE}/api/auth/organization/list`, {
      headers: { cookie },
    });
    const organizations = z.array(z.unknown()).parse(await list.json());
    expect(organizations).toHaveLength(2);

    const setActive = await fetch(`${BASE}/api/auth/organization/set-active`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ organizationSlug: `beta-${stamp}` }),
    });
    expect(setActive.status).toBe(200);

    const session = await fetch(`${BASE}/api/auth/get-session`, {
      headers: { cookie },
    });
    const body = z
      .object({
        session: z.object({ activeOrganizationId: z.uuid().nullable() }),
      })
      .parse(await session.json());
    expect(body.session.activeOrganizationId).toBeTruthy();
  });

  it("guards the flag mutation path — unauthenticated callers get 403", async () => {
    const res = await fetch(`${BASE}/admin/flags`, {
      method: "PUT",
      headers: ORIGIN,
      body: JSON.stringify({ key: "smoke", enabled: true, rolloutPct: 100 }),
    });
    expect(res.status).toBe(403);
  });

  it("lets an org admin flip a flag (the operator kill switch)", async () => {
    const email = `smoke-flag-${Date.now()}@example.com`;
    const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({
        name: "Flag Smoke",
        email,
        password: "correct-horse-battery-staple",
      }),
    });
    const cookie = signUp.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authed = { ...ORIGIN, cookie };
    const slug = `flagorg-${Date.now()}`;

    await fetch(`${BASE}/api/auth/organization/create`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ name: slug, slug }),
    });
    await fetch(`${BASE}/api/auth/organization/set-active`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ organizationSlug: slug }),
    });

    const res = await fetch(`${BASE}/admin/flags`, {
      method: "PUT",
      headers: authed,
      body: JSON.stringify({
        key: `smoke-${Date.now()}`,
        enabled: true,
        rolloutPct: 50,
      }),
    });
    expect(res.status).toBe(200);
  });

  it("serves the SPA from the same origin — one service, one origin", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("/assets/");

    // Hashed assets are immutable; index.html is the pointer and must not cache.
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
    expect(asset, "index.html must reference a built asset").toBeTruthy();
    const js = await fetch(`${BASE}${asset}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("immutable");
  });

  it("does not turn unknown API paths into successful HTML responses", async () => {
    const response = await fetch(`${BASE}/api/not-a-route`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("rejects authentication mutations from untrusted origins", async () => {
    const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { ...ORIGIN, origin: "https://untrusted.example" },
      body: JSON.stringify({
        email: "origin-check@example.com",
        password: "correct-horse-battery-staple",
      }),
    });
    expect(response.status).toBe(403);
  });
  it("deep-links client routes via the fallback without shadowing the API", async () => {
    const deep = await fetch(`${BASE}/some/client/route`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");

    // The fallback is registered last: real routes still answer as themselves.
    const spec = await fetch(`${BASE}/openapi.json`);
    expect(spec.headers.get("content-type")).toContain("application/json");
  });
});
