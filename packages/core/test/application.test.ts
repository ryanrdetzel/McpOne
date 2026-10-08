import type { Env } from "@scaffold/config";
import type { Database } from "@scaffold/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/index";

const { checkDatabase, authHandler } = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  authHandler: vi.fn(),
}));
vi.mock("@scaffold/database", () => ({ checkDatabase }));
vi.mock("../src/auth", () => ({
  createAuth: () => ({ handler: authHandler, api: { getSession: vi.fn() } }),
}));

const env: Env = {
  NODE_ENV: "test",
  APP_SLUG: "mcpone",
  RELEASE: "unit-release",
  BETTER_AUTH_URL: "http://localhost:8787",
  BETTER_AUTH_SECRET: "not-to-be-logged",
  TRUSTED_ORIGINS: ["http://localhost:8787"],
};

beforeEach(() => {
  vi.resetAllMocks();
  checkDatabase.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("shared application middleware", () => {
  it("echoes request IDs and emits the structured request log without secrets", async () => {
    const app = createApplication({ env, db: {} as Database });
    const response = await app.request("/healthz", {
      headers: { "x-request-id": "req-one", cookie: "private-session-cookie" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-one");
    const line = vi.mocked(console.log).mock.calls[0]?.[0];
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      release: "unit-release",
      msg: "request",
      req_id: "req-one",
      route: "/healthz",
      method: "GET",
      status: 200,
      dur_ms: expect.any(Number),
      time: expect.any(String),
    });
    expect(line).not.toContain("not-to-be-logged");
    expect(line).not.toContain("private-session-cookie");
  });

  it("generates a UUID request ID when none is supplied", async () => {
    const app = createApplication({ env, db: {} as Database });
    const response = await app.request("/healthz");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it.each([false, true])(
    "returns bodyless HEAD responses when readiness fails: %s",
    async (failure) => {
      const app = createApplication({ env, db: {} as Database });
      if (failure)
        checkDatabase.mockRejectedValueOnce(new Error("no such table: users"));
      const response = await app.request("/healthz", { method: "HEAD" });
      expect(response.status).toBe(failure ? 503 : 200);
      expect(await response.text()).toBe("");
      expect(response.headers.get("x-request-id")).toBeTruthy();
    },
  );

  it("redacts server errors in responses while serializing errors in logs", async () => {
    const app = createApplication({ env, db: {} as Database });
    app.get("/failure", () => {
      throw new Error("diagnostic failure");
    });
    const response = await app.request("/failure", {
      headers: { "x-request-id": "error-id" },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(response.headers.get("x-request-id")).toBe("error-id");
    const line = vi.mocked(console.error).mock.calls[0]?.[0];
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      release: "unit-release",
      msg: "unhandled error",
      req_id: "error-id",
      route: "/failure",
      method: "GET",
      err: {
        type: "Error",
        message: "diagnostic failure",
        stack: expect.any(String),
      },
    });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0])).toMatchObject(
      { status: 500 },
    );
  });

  it("strips HEAD bodies from platform fallback responses", async () => {
    const app = createApplication({ env, db: {} as Database });
    app.notFound(
      () => new Response("asset", { headers: { "content-type": "text/html" } }),
    );
    const response = await app.request("/client/deep-link", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBe("text/html");
  });
});
