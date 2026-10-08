import type { Env } from "@scaffold/config";
import type { Database } from "@scaffold/database";
import { DashboardStatus, Health } from "@scaffold/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRoutes } from "../src/routes";

const { checkDatabase } = vi.hoisted(() => ({ checkDatabase: vi.fn() }));
vi.mock("@scaffold/database", () => ({ checkDatabase }));

const env: Env = {
  NODE_ENV: "test",
  APP_SLUG: "mcpone",
  RELEASE: "unit-release",
  BETTER_AUTH_URL: "http://localhost:8787",
  BETTER_AUTH_SECRET: "unit-secret",
  TRUSTED_ORIGINS: ["http://localhost:8787"],
};
const db = {} as Database;
const flags = { flagEnabled: vi.fn(), invalidateFlagCache: vi.fn() };
const requireOrgRole = vi.fn();
const api = new ApiRoutes({ env, db, flags, requireOrgRole }).api;

beforeEach(() => {
  vi.resetAllMocks();
  checkDatabase.mockResolvedValue(undefined);
});

describe("schema readiness routes", () => {
  it("returns 503 from health without exposing database details", async () => {
    checkDatabase.mockRejectedValueOnce(new Error("no such table: users"));
    const response = await api.request("/healthz");
    expect(response.status).toBe(503);
    expect(Health.parse(await response.json())).toEqual({
      ok: false,
      release: "unit-release",
    });
  });

  it("preserves the dashboard contract when schema readiness fails", async () => {
    checkDatabase.mockRejectedValueOnce(
      new Error("no such table: feature_flags"),
    );
    const response = await api.request("/api/dashboard");
    expect(response.status).toBe(503);
    expect(DashboardStatus.parse(await response.json())).toEqual({
      appSlug: "mcpone",
      release: "unit-release",
      database: false,
    });
  });

  it("returns an unavailable database response instead of an uncaught error", async () => {
    checkDatabase.mockRejectedValueOnce(new Error("no such table: sessions"));
    const response = await api.request("/db");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("denies flag mutations without an active-org admin", async () => {
    requireOrgRole.mockResolvedValueOnce({
      ok: false,
      error: "insufficient_role",
    });
    const response = await api.request("/admin/flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "flag", enabled: true, rolloutPct: 50 }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "insufficient_role" });
    expect(requireOrgRole).toHaveBeenCalledWith(expect.anything(), [
      "owner",
      "admin",
    ]);
    expect(flags.invalidateFlagCache).not.toHaveBeenCalled();
  });

  it("rejects invalid rollout percentages before authorization or writes", async () => {
    const response = await api.request("/admin/flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "flag", enabled: true, rolloutPct: 101 }),
    });
    expect(response.status).toBe(400);
    expect(requireOrgRole).not.toHaveBeenCalled();
    expect(flags.invalidateFlagCache).not.toHaveBeenCalled();
  });
});
