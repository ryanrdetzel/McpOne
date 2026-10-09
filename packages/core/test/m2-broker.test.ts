import { SQLiteBinding } from "@scaffold/database/sqlite";
import type { Permission, Requirement } from "@scaffold/schema/integrations";
import { afterEach, describe, expect, it } from "vitest";
import { ControlError } from "../src/execution/service";
import type {
  AccountAuthorization,
  AccountsService,
} from "../src/integrations/accounts";
import {
  type BrokerOptions,
  brokerUrl,
  createBroker,
} from "../src/integrations/broker";
import {
  type HttpTransportInput,
  TransportError,
} from "../src/integrations/transport";

const opened: SQLiteBinding[] = [];
afterEach(() => {
  for (const binding of opened.splice(0)) binding.close();
});
const permission: Permission = {
  requirement: null,
  origin: "https://api.github.com",
  path: "/user",
  match: "exact",
  methods: ["GET"],
};
const requirement: Requirement = {
  provider: "github",
  methods: ["bearer"],
  scopes: [],
};
function setup(options: Partial<BrokerOptions> = {}) {
  const requests: HttpTransportInput[] = [],
    claims: unknown[] = [];
  const broker = createBroker({
    transport: {
      async request(input) {
        requests.push(input);
        return Response.json({ login: "unit" });
      },
    },
    accounts: {} as AccountsService,
    orgId: "unit-org",
    principalId: "unit-user",
    requirements: {},
    selections: {},
    permissions: [permission],
    signal: AbortSignal.timeout(60000),
    async beforeRequest(input) {
      claims.push(input);
    },
    ...options,
  });
  return { broker, requests, claims };
}
describe("M2 Broker guest/trusted capability checks with controlled network", () => {
  it("requires explicit null permission and rejects guest authority/protocol fields", async () => {
    const { broker, requests } = setup();
    await expect(
      broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).resolves.toMatchObject({ status: 200, body: { login: "unit" } });
    for (const extra of [
      { controlTraffic: true },
      { accountRequirements: ["source"] },
      { accountId: "other" },
      { _account: "fixed" },
    ])
      await expect(
        broker.request({
          ...extra,
          accountRequirement: null,
          method: "GET",
          url: "https://api.github.com/user",
        } as never),
      ).rejects.toMatchObject({ code: "broker_forbidden" });
    await expect(
      broker.request({
        accountRequirement: "source",
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).rejects.toMatchObject({ code: "broker_forbidden" });
    expect(requests).toHaveLength(1);
    expect(broker.effect()).toEqual({ state: "completed" });
  });
  it.each([
    "https://api.github.com/user/../admin",
    "https://api.github.com/user/%2e%2e/admin",
    "https://api.github.com/user/%2fadmin",
    "https://api.github.com/user/%5cadmin",
    "https://api.github.com/user/%00",
    "https://api.github.com/user\\admin",
    "https://token@api.github.com/user",
    "https://api.github.com:444/user",
    "https://127.0.0.1/user",
    "https://2130706433/user",
  ])("rejects noncanonical unsafe URL %s", (url) => {
    expect(() => brokerUrl(url)).toThrow();
  });
  it("preserves reviewed business query names without interpreting them as credential injection", () => {
    expect(
      brokerUrl(
        "https://api.github.com/user?token=public-pagination-cursor",
      ).searchParams.get("token"),
    ).toBe("public-pagination-cursor");
  });
  it("uses segment-boundary prefix matching and copies immutable permissions", async () => {
    const reviewed: Permission = {
      ...permission,
      path: "/v1/a",
      match: "prefix",
    };
    const { broker, requests } = setup({ permissions: [reviewed] });
    reviewed.path = "/v1/admin";
    await broker.request({
      accountRequirement: null,
      method: "GET",
      url: "https://api.github.com/v1/a/item",
    });
    await expect(
      broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/v1/admin",
      }),
    ).rejects.toMatchObject({ code: "broker_forbidden" });
    expect(requests).toHaveLength(1);
  });
  it.each([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "forwarded",
    "x-forwarded-for",
    "accept-encoding",
    "mcp-session-id",
  ])(
    "rejects forbidden header even when configuration tries approving %s",
    async (name) => {
      expect(() => setup({ requestHeaders: [name] })).toThrow();
      const { broker, requests } = setup();
      await expect(
        broker.request({
          accountRequirement: null,
          method: "GET",
          url: "https://api.github.com/user",
          headers: { [name]: "public-unit" },
        }),
      ).rejects.toMatchObject({ code: "broker_forbidden" });
      expect(requests).toHaveLength(0);
    },
  );
  it("fences current claim/budget before credential injection and send; refuses rejected claim without effect", async () => {
    const order: string[] = [];
    const accounts = {
      async authorize(input: AccountAuthorization) {
        order.push("account-current");
        await input.beforeCredentialUse?.({
          totalBytes: 64,
          maxValueBytes: 32,
        });
        order.push("inject");
        const headers = new Headers(input.headers);
        headers.set("authorization", "Bearer public-unit-marker");
        return {
          headers,
          redact(text: string) {
            return text.split("public-unit-marker").join("[redacted]");
          },
        };
      },
    } as AccountsService;
    const selected = {
      accountId: crypto.randomUUID(),
      identityDigest: "1".repeat(64),
      alias: "Unit",
      requirement: "source",
    };
    const { broker } = setup({
      accounts,
      requirements: { source: requirement },
      selections: { source: selected },
      permissions: [{ ...permission, requirement: "source" }],
      async beforeRequest() {
        order.push("claim-budget-effect");
      },
      transport: {
        async request(input) {
          order.push("send");
          expect(input.headers.get("authorization")).toBe(
            "Bearer public-unit-marker",
          );
          return new Response(
            '{"echo":"\\u0070ublic-unit-marker","nested":[{"value":"\\u0070ublic-unit-marker"}]}',
            { headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    expect(
      await broker.request({
        accountRequirement: "source",
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).toMatchObject({
      body: {
        echo: "[redacted]",
        nested: [{ value: "[redacted]" }],
      },
    });
    expect(order).toEqual([
      "account-current",
      "claim-budget-effect",
      "inject",
      "send",
    ]);
    const rejected = setup({
      async beforeRequest() {
        throw new ControlError("grant_revoked", "The Grant is revoked.", 403);
      },
    });
    await expect(
      rejected.broker.requestRaw({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).rejects.toMatchObject({
      code: "grant_revoked",
      effect: { state: "not_dispatched" },
    });
    expect(rejected.requests).toHaveLength(0);
  });
  it("rejects credential-bearing decoded JSON keys instead of renaming them", async () => {
    const { broker } = setup({
      accounts: {
        async authorize(input: AccountAuthorization) {
          await input.beforeCredentialUse?.({
            totalBytes: 0,
            maxValueBytes: 0,
          });
          return {
            headers: input.headers,
            redact: (text: string) =>
              text.split("public-unit-marker").join("[redacted]"),
          };
        },
      } as AccountsService,
      requirements: { source: requirement },
      selections: {
        source: {
          accountId: crypto.randomUUID(),
          identityDigest: "1".repeat(64),
          alias: "Unit",
          requirement: "source",
        },
      },
      permissions: [{ ...permission, requirement: "source" }],
      transport: {
        async request() {
          return new Response('{"\\u0070ublic-unit-marker":"value"}', {
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    await expect(
      broker.request({
        accountRequirement: "source",
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).rejects.toMatchObject({ code: "unsupported_result" });
  });
  it("counts every manual redirect against one durable logical budget across broker recreation", async () => {
    const binding = new SQLiteBinding(":memory:");
    opened.push(binding);
    await binding.exec(
      "CREATE TABLE unit_budget(id TEXT PRIMARY KEY, count INTEGER NOT NULL); INSERT INTO unit_budget VALUES('run',0);",
    );
    const beforeRequest: BrokerOptions["beforeRequest"] = async () => {
      const consumed = await binding
        .prepare(
          "UPDATE unit_budget SET count=count+1 WHERE id='run' AND count<30 RETURNING count",
        )
        .first();
      if (!consumed)
        throw new ControlError(
          "capacity_exceeded",
          "The Run request budget is exhausted.",
          429,
        );
    };
    let attempts = 0;
    const transport = {
      async request() {
        attempts++;
        return attempts === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "/user/final" },
            })
          : Response.json({ ok: true });
      },
    };
    const options = {
      beforeRequest,
      transport,
      permissions: [{ ...permission, path: "/user", match: "prefix" as const }],
    };
    await setup(options).broker.request({
      accountRequirement: null,
      method: "GET",
      url: "https://api.github.com/user",
    });
    for (let i = 0; i < 28; i++)
      await setup(options).broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      });
    await expect(
      setup(options).broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    expect(attempts).toBe(30);
    expect(
      await binding.prepare("SELECT count FROM unit_budget").first("count"),
    ).toBe(30);
  });
  it("rejects unpermitted redirect origins, traversal and uncertain mutation replay; never claims no-effect from response", async () => {
    for (const location of [
      "https://echo.example.com/user",
      "/user/../user",
      "/user/%2e%2e/user",
    ]) {
      const { broker } = setup({
        transport: {
          async request() {
            return new Response(null, { status: 302, headers: { location } });
          },
        },
      });
      await expect(
        broker.request({
          accountRequirement: null,
          method: "GET",
          url: "https://api.github.com/user",
        }),
      ).rejects.toMatchObject({
        code: "broker_forbidden",
        effect: { state: "possible" },
      });
      expect(broker.effect()).toEqual({ state: "possible" });
    }
    const { broker, requests } = setup({
      permissions: [{ ...permission, methods: ["POST"] }],
      transport: {
        async request(input) {
          requests.push(input);
          return new Response(null, {
            status: 307,
            headers: { location: "/user" },
          });
        },
      },
    });
    await expect(
      broker.request({
        accountRequirement: null,
        method: "POST",
        url: "https://api.github.com/user",
        body: { write: true },
      }),
    ).rejects.toMatchObject({ code: "broker_forbidden" });
    expect(requests).toHaveLength(1);
  });
  it("isolates trusted MCP session headers and control traffic; strips cookie/header/error-body diagnostics", async () => {
    const { broker, requests } = setup({
      transport: {
        async request(input) {
          requests.push(input);
          return Response.json(
            { ok: true },
            {
              headers: {
                "set-cookie": "secret-cookie",
                "mcp-session-id": "secret-session",
                "x-diagnostics": "secret-diagnostic",
                etag: "safe-etag",
              },
            },
          );
        },
      },
    });
    await broker.requestRaw({
      accountRequirement: null,
      method: "GET",
      url: "https://api.github.com/user",
      trustedHeaders: { "mcp-session-id": "public-unit-session" },
      controlTraffic: true,
    });
    expect(broker.effect()).toEqual({ state: "not_dispatched" });
    expect(broker.redact("public-unit-session")).toBe("[redacted]");
    const result = await broker.request({
      accountRequirement: null,
      method: "GET",
      url: "https://api.github.com/user",
    });
    expect(result.headers).not.toHaveProperty("set-cookie");
    expect(result.headers).not.toHaveProperty("mcp-session-id");
    expect(result.headers).not.toHaveProperty("x-diagnostics");
    const failed = setup({
      transport: {
        async request() {
          return new Response("credential-private-error-body", { status: 401 });
        },
      },
    });
    try {
      await failed.broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("credential-private-error-body");
      expect(error).toMatchObject({ code: "upstream_rejected" });
    }
  });
  it.each(["dns_failure", "connection_failure", "timeout"] as const)(
    "accepts only trusted zero-send %s as retryable verified-no-effect",
    async (code) => {
      const { broker, claims } = setup({
        transport: {
          async request() {
            throw new TransportError(code, false);
          },
        },
      });
      await expect(
        broker.request({
          accountRequirement: null,
          method: "GET",
          url: "https://api.github.com/user",
        }),
      ).rejects.toMatchObject({
        code: "upstream_unavailable",
        retryable: true,
        effect: { state: "verified_no_effect" },
      });
      expect(claims).toHaveLength(1);
      expect(broker.effect().state).toBe("verified_no_effect");
    },
  );
  it("never treats unsafe targets or post-write failure as an automatic retry witness", async () => {
    const unsafe = setup({
      transport: {
        async request() {
          throw new TransportError("unsafe_target", false);
        },
      },
    });
    await expect(
      unsafe.broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).rejects.toMatchObject({
      code: "broker_forbidden",
      retryable: false,
      effect: { state: "verified_no_effect" },
    });
    const uncertain = setup({
      transport: {
        async request() {
          throw new TransportError("connection_failure", true);
        },
      },
    });
    await expect(
      uncertain.broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).rejects.toMatchObject({
      code: "upstream_unavailable",
      retryable: false,
      effect: { state: "possible" },
    });
  });
  it.each(["completed", "possible"] as const)(
    "preserves earlier whole-Tool %s evidence after later zero-send failure",
    async (state) => {
      let calls = 0;
      const { broker } = setup({
        permissions: [{ ...permission, methods: ["POST"] }],
        transport: {
          async request() {
            if (++calls === 1) return Response.json({ accepted: true });
            throw new TransportError("dns_failure", false);
          },
        },
      });
      const request = {
        accountRequirement: null,
        method: "POST" as const,
        url: "https://api.github.com/user",
        body: { write: true },
      };
      if (state === "completed") await broker.request(request);
      else
        await broker.requestRaw({
          ...request,
          body: new TextEncoder().encode("{}"),
          mediaType: "application/json",
        });
      await expect(broker.request(request)).rejects.toMatchObject({
        effect: { state },
      });
      expect(broker.effect()).toEqual({ state });
    },
  );
  it("does not let a later successful guest response acknowledge earlier unparsed raw dispatch", async () => {
    const { broker } = setup();
    await broker.requestRaw({
      accountRequirement: null,
      method: "GET",
      url: "https://api.github.com/user",
    });
    await broker.request({
      accountRequirement: null,
      method: "GET",
      url: "https://api.github.com/user",
    });
    expect(broker.effect()).toEqual({ state: "possible" });
  });
  it.each([
    () =>
      new Response('{"private":"upstream-private-marker"', {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("x".repeat(1048577), {
        headers: { "content-type": "text/plain" },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "text/plain" },
      }),
  ])(
    "requires full bounded valid UTF-8/JSON before acknowledging completion",
    async (response) => {
      const { broker } = setup({
        transport: {
          async request() {
            return response();
          },
        },
      });
      try {
        await broker.request({
          accountRequirement: null,
          method: "GET",
          url: "https://api.github.com/user",
        });
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toMatchObject({
          code: "unsupported_result",
          effect: { state: "possible" },
        });
        expect(String(error)).not.toContain("upstream-private-marker");
      }
    },
  );
  it("holds binary admission across dispatch and ready-artifact acknowledgement", async () => {
    const order: string[] = [];
    const artifact = {
      artifact_id: crypto.randomUUID(),
      media_type: "application/octet-stream",
      size_bytes: 1,
      sha256: "a".repeat(64),
      filename: "unit.bin",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    const { broker } = setup({
      async withBinaryAdmission(callback) {
        order.push("admit");
        try {
          return await callback();
        } finally {
          order.push("release");
        }
      },
      transport: {
        async request() {
          order.push("send");
          return new Response(new Uint8Array([1]), {
            headers: { "content-type": "application/octet-stream" },
          });
        },
      },
      async artifact(response) {
        order.push("ready");
        expect(await response.arrayBuffer()).toHaveProperty("byteLength", 1);
        return artifact;
      },
    });
    expect(
      await broker.request({
        accountRequirement: null,
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).toMatchObject({ body: { artifact } });
    expect(broker.effect()).toEqual({ state: "completed" });
    expect(order).toEqual(["admit", "send", "ready", "release"]);
  });
});
