import type {
  FrozenTool,
  JSONValue,
  RemoteMcpSource,
  ToolDefinition,
} from "@scaffold/schema/integrations";
import { describe, expect, it } from "vitest";
import {
  classifyRemoteManifestDrift,
  createRemoteMcpAdapter,
  REMOTE_IMPLEMENTATION_LIMITATION,
  REMOTE_MCP_PROTOCOL_VERSION,
  type RemoteBroker,
  type RemoteMcpDependencies,
  RemoteMcpError,
  type RemoteRawRequest,
} from "../src/integrations/remote-mcp";
import type {
  HttpTransport,
  HttpTransportInput,
} from "../src/integrations/transport";

// Controlled protocol corpus, not real GitHub Account/OAuth or hosted acceptance proof.
const endpoint = "https://api.githubcopilot.com/mcp/";
const owner = { orgId: "organization", userId: "owner", slug: "github" };
const source: RemoteMcpSource = {
  kind: "remote_mcp",
  endpoint,
  namespace: "github",
  nameMapping: {},
};
const accountId = "10000000-0000-4000-8000-000000000001";
const inputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  additionalProperties: false,
};
const upstreamTool = (
  name = "get_me",
  extra: Record<string, unknown> = {},
) => ({
  name,
  description: "Read the selected test identity",
  inputSchema,
  ...extra,
});
const wire = (
  id: unknown,
  result: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json", ...headers },
  });
const initialized = (
  id: unknown,
  session = "test-session",
  version: string = REMOTE_MCP_PROTOCOL_VERSION,
) =>
  wire(
    id,
    {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: "controlled-protocol-fixture", version: "1" },
    },
    { "mcp-session-id": session },
  );
function decode(body: Uint8Array | undefined): Record<string, unknown> {
  return body ? JSON.parse(new TextDecoder().decode(body)) : {};
}
type Exchange = {
  method: string;
  message: Record<string, unknown>;
  input: HttpTransportInput | RemoteRawRequest;
};
function fixture(
  handler?: (exchange: Exchange) => Response | Promise<Response>,
) {
  const exchanges: Exchange[] = [];
  let session = 0;
  async function respond(
    input: HttpTransportInput | RemoteRawRequest,
  ): Promise<Response> {
    const exchange = {
      method: input.method,
      message: decode(input.body),
      input,
    };
    exchanges.push(exchange);
    if (handler) return handler(exchange);
    if (input.method === "DELETE") return new Response(null, { status: 204 });
    if (exchange.message.method === "initialize")
      return initialized(exchange.message.id, `session-${++session}`);
    if (
      exchange.message.method === "notifications/initialized" ||
      "error" in exchange.message
    )
      return new Response(null, { status: 202 });
    if (exchange.message.method === "tools/list")
      return wire(exchange.message.id, { tools: [upstreamTool()] });
    if (exchange.message.method === "tools/call")
      return wire(exchange.message.id, {
        content: [{ type: "text", text: "selected identity" }],
        structuredContent: { login: "test-only" },
      });
    throw new Error("Unexpected controlled fixture operation");
  }
  const transport: HttpTransport = { request: respond };
  const broker: RemoteBroker = { requestRaw: respond };
  return { transport, broker, exchanges, respond };
}
function frozen(definition?: ToolDefinition): FrozenTool {
  const actual: ToolDefinition = definition ?? {
    name: "github.get_me",
    upstreamName: "get_me",
    description: "Read identity",
    inputSchema,
    operationClass: "unknown",
    requirements: {
      remote: { provider: "github", methods: ["bearer", "oauth2"], scopes: [] },
    },
    permissions: [
      {
        requirement: "remote",
        origin: "https://api.githubcopilot.com",
        methods: ["POST", "DELETE"],
        path: "/mcp/",
        match: "exact",
      },
    ],
    implementation: {
      kind: "remote_mcp",
      endpoint,
      protocolVersion: REMOTE_MCP_PROTOCOL_VERSION,
      toolName: "get_me",
    },
  };
  return {
    toolId: accountId,
    name: actual.name,
    toolRevision: "immutable-tool",
    integrationId: accountId,
    integrationRevision: "immutable-integration",
    artifactDigest: "a".repeat(64),
    definition: actual,
  };
}
async function invoke(
  dependencies: RemoteMcpDependencies,
  broker: RemoteBroker,
  tool = frozen(),
  args: Record<string, JSONValue> = {},
  deadlineMs = Date.now() + 5_000,
) {
  return createRemoteMcpAdapter(dependencies).invokeTool({
    runId: "run",
    claimId: "claim",
    tool,
    arguments: args,
    deadlineMs,
    broker,
  });
}
function protocol(
  handler: (exchange: Exchange) => Response | Promise<Response>,
) {
  return fixture(async (exchange) => {
    if (exchange.method === "DELETE")
      return new Response(null, { status: 204 });
    if (exchange.message.method === "initialize")
      return initialized(exchange.message.id);
    if (
      exchange.message.method === "notifications/initialized" ||
      "error" in exchange.message
    )
      return new Response(null, { status: 202 });
    return handler(exchange);
  });
}
function sse(id: unknown, result: unknown, before = "", after = "") {
  return new Response(
    `${before}data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n${after}`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("D12 remote HTTPS Streamable HTTP protocol and source review", () => {
  it("initializes, notifies, paginates discovery and cleans a private session without calling business Tools", async () => {
    const remote = protocol(({ message }) => {
      const params = message.params;
      const second =
        params !== null && typeof params === "object" && "cursor" in params;
      return wire(
        message.id,
        second
          ? { tools: [upstreamTool("second")] }
          : { tools: [upstreamTool()], nextCursor: "opaque-page-two" },
      );
    });
    const resolution = await createRemoteMcpAdapter(remote).resolveTools(
      source,
      owner,
    );
    expect(
      resolution.accepted.map((tool) => [tool.name, tool.upstreamName]),
    ).toEqual([
      ["github.get_me", "get_me"],
      ["github.second", "second"],
    ]);
    expect(
      remote.exchanges.map(
        (exchange) => exchange.message.method ?? exchange.method,
      ),
    ).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "DELETE",
    ]);
    expect(remote.exchanges[0]?.message.params).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: {},
    });
    for (const exchange of remote.exchanges.slice(1)) {
      expect(
        new Headers(exchange.input.headers).get("mcp-protocol-version"),
      ).toBe("2025-06-18");
      expect(new Headers(exchange.input.headers).get("mcp-session-id")).toBe(
        "test-session",
      );
    }
    expect(resolution.snapshot).toMatchObject({
      protocolVersion: "2025-06-18",
      sessionRequired: true,
      implementationPinned: false,
      limitation: REMOTE_IMPLEMENTATION_LIMITATION,
    });
    expect(resolution.snapshot.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(resolution)).not.toContain("test-session");
  });
  it("requires an owner trusted Account adapter and publishes compatibility, never a discovery Account ID", async () => {
    const remote = fixture();
    let chosen: string | undefined;
    const adapter = createRemoteMcpAdapter({
      transport: remote.transport,
      discoveryTransport: async (_owner, id, exact) => {
        expect(exact).toBe(endpoint);
        chosen = id;
        return remote.transport;
      },
      describeAuthentication: async (_owner, id, exact) => {
        expect(id).toBe(accountId);
        expect(exact).toBe(endpoint);
        return {
          requirement: "remote",
          definition: { provider: "github", methods: ["bearer"], scopes: [] },
        };
      },
    });
    const reviewed = await adapter.resolveTools(
      { ...source, accountId },
      owner,
    );
    expect(chosen).toBe(accountId);
    expect(reviewed.accepted[0]?.requirements).toEqual({
      remote: { provider: "github", methods: ["bearer"], scopes: [] },
    });
    expect(JSON.stringify(reviewed)).not.toContain(accountId);
    await expect(
      createRemoteMcpAdapter(remote).resolveTools(
        { ...source, accountId },
        owner,
      ),
    ).rejects.toMatchObject({
      code: "account_incompatible",
      effect: { state: "not_dispatched" },
    });
  });
  it("refuses an incompatible selected Account rather than sending it to an arbitrary origin", async () => {
    const remote = fixture();
    const adapter = createRemoteMcpAdapter({
      transport: remote.transport,
      discoveryTransport: async () => remote.transport,
      describeAuthentication: async () => null,
    });
    await expect(
      adapter.resolveTools(
        { ...source, endpoint: "https://untrusted.example/mcp", accountId },
        owner,
      ),
    ).rejects.toMatchObject({ code: "account_incompatible" });
    expect(remote.exchanges).toHaveLength(0);
  });
  it("refuses credential echo in a selected discovery manifest rather than changing schemas", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, {
        tools: [upstreamTool("get_me", { description: "secret-echo" })],
      }),
    );
    const adapter = createRemoteMcpAdapter({
      transport: remote.transport,
      discoveryTransport: async () => ({
        ...remote.transport,
        redact: (text) => text.replaceAll("secret-echo", "[redacted]"),
      }),
      describeAuthentication: async () => ({
        requirement: "remote",
        definition: { provider: "github", methods: ["bearer"], scopes: [] },
      }),
    });
    await expect(
      adapter.resolveTools({ ...source, accountId }, owner),
    ).rejects.toMatchObject({ code: "import_invalid" });
  });
  it("rejects both normalized collisions unless explicit mappings retain verbatim upstream names", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, {
        tools: [upstreamTool("Read-User"), upstreamTool("Read_User")],
      }),
    );
    const adapter = createRemoteMcpAdapter(remote);
    const rejected = await adapter.resolveTools(source, owner);
    expect(rejected.accepted).toHaveLength(0);
    expect(rejected.rejected.map((entry) => entry.code)).toEqual([
      "name_collision",
      "name_collision",
    ]);
    const mapped = await adapter.resolveTools(
      {
        ...source,
        nameMapping: {
          "Read-User": "github.read_user_dash",
          Read_User: "github.read_user_underscore",
        },
      },
      owner,
    );
    expect(mapped.accepted.map((tool) => tool.upstreamName)).toEqual([
      "Read-User",
      "Read_User",
    ]);
    expect(
      mapped.accepted.map(
        (tool) =>
          tool.implementation.kind === "remote_mcp" &&
          tool.implementation.toolName,
      ),
    ).toEqual(["Read-User", "Read_User"]);
  });
  it("reviews supported schemas without dropping constraints and never trusts server read-only hints", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, {
        tools: [
          upstreamTool("get_me", { annotations: { readOnlyHint: true } }),
          upstreamTool("conditional", {
            inputSchema: { type: "object", not: {} },
          }),
          upstreamTool("reserved", {
            inputSchema: {
              type: "object",
              properties: { _account: { type: "string" } },
            },
          }),
        ],
      }),
    );
    const review = await createRemoteMcpAdapter(remote).resolveTools(
      source,
      owner,
    );
    expect(review.accepted).toHaveLength(1);
    expect(review.accepted[0]?.inputSchema).toEqual(inputSchema);
    expect(review.accepted[0]?.operationClass).toBe("unknown");
    expect(
      review.rejected.map((entry) => [entry.upstreamName, entry.code]),
    ).toEqual([
      ["conditional", "unsupported_schema"],
      ["reserved", "name_collision"],
    ]);
  });
  it.each([
    "http://remote.example/mcp",
    "https://user@remote.example/mcp",
    "https://remote.example/mcp#fragment",
    "https://remote.example:8443/mcp",
    "https://remote.example/a%2fb",
    "https://remote.example/a/../mcp",
  ])(
    "rejects unsafe or noncanonical endpoint %s before discovery",
    async (bad) => {
      const remote = fixture();
      await expect(
        createRemoteMcpAdapter(remote).resolveTools(
          { ...source, endpoint: bad },
          owner,
        ),
      ).rejects.toBeInstanceOf(RemoteMcpError);
      expect(remote.exchanges).toHaveLength(0);
    },
  );
  it("rejects repeated cursors, duplicate names, too many Tools and too many pages", async () => {
    for (const mode of ["cursor", "duplicate", "tools", "pages"]) {
      let pages = 0;
      const remote = protocol(({ message }) => {
        pages++;
        if (mode === "tools")
          return wire(message.id, {
            tools: Array.from({ length: 501 }, (_, index) =>
              upstreamTool(`tool_${index}`),
            ),
          });
        if (mode === "duplicate")
          return wire(message.id, { tools: [upstreamTool(), upstreamTool()] });
        return wire(message.id, {
          tools: [],
          nextCursor: mode === "cursor" ? "repeated" : `page-${pages}`,
        });
      });
      await expect(
        createRemoteMcpAdapter(remote).resolveTools(source, owner),
      ).rejects.toMatchObject({ code: "import_invalid" });
      expect(
        remote.exchanges.some(
          (exchange) => exchange.message.method === "tools/call",
        ),
      ).toBe(false);
    }
  });
  it("rejects composed or referenced root Account-selector collisions but preserves nested business fields", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, {
        tools: [
          upstreamTool("composed", {
            inputSchema: {
              type: "object",
              allOf: [{ properties: { _account: { type: "string" } } }],
            },
          }),
          upstreamTool("referenced", {
            inputSchema: {
              $ref: "#/$defs/root",
              $defs: {
                root: {
                  type: "object",
                  properties: { _account: { type: "string" } },
                },
              },
            },
          }),
          upstreamTool("nested", {
            inputSchema: {
              type: "object",
              properties: {
                business: {
                  type: "object",
                  properties: { _account: { type: "string" } },
                },
              },
            },
          }),
        ],
      }),
    );
    const review = await createRemoteMcpAdapter(remote).resolveTools(
      source,
      owner,
    );
    expect(review.accepted.map((tool) => tool.name)).toEqual(["github.nested"]);
    expect(review.rejected.map((entry) => entry.code)).toEqual([
      "name_collision",
      "name_collision",
    ]);
  });
  it("admits 32 supported schema edges even when RPC and property containers exceed 64 JSON edges", async () => {
    let schema: Record<string, JSONValue> = { type: "string" };
    for (let index = 0; index < 32; index++)
      schema = { type: "object", properties: { child: schema } };
    const remote = protocol(({ message }) =>
      wire(message.id, {
        tools: [upstreamTool("nested_schema", { inputSchema: schema })],
      }),
    );
    const review = await createRemoteMcpAdapter(remote).resolveTools(
      source,
      owner,
    );
    expect(review.accepted.map((tool) => tool.name)).toEqual([
      "github.nested_schema",
    ]);
    expect(review.rejected).toHaveLength(0);
  });
  it("rejects incompatible protocol negotiation and cleans the private session", async () => {
    const remote = fixture(({ method, message }) =>
      method === "DELETE"
        ? new Response(null, { status: 204 })
        : initialized(message.id, "private-session", "2024-11-05"),
    );
    await expect(
      createRemoteMcpAdapter(remote).resolveTools(source, owner),
    ).rejects.toMatchObject({ code: "unsupported_protocol" });
    expect(remote.exchanges.at(-1)?.method).toBe("DELETE");
  });
});

describe("D12 remote discovery numerical boundaries", () => {
  it("accepts 500 Tools and 100 finite pages but rejects aggregate manifests above five MiB", async () => {
    const many = protocol(({ message }) =>
      wire(message.id, {
        tools: Array.from({ length: 500 }, (_, index) =>
          upstreamTool(`tool_${index}`),
        ),
      }),
    );
    expect(
      (await createRemoteMcpAdapter(many).resolveTools(source, owner)).accepted,
    ).toHaveLength(500);
    let count = 0;
    const pages = protocol(({ message }) =>
      wire(message.id, {
        tools: [],
        ...(++count < 100 ? { nextCursor: `page-${count}` } : {}),
      }),
    );
    expect(
      (await createRemoteMcpAdapter(pages).resolveTools(source, owner))
        .accepted,
    ).toHaveLength(0);
    expect(count).toBe(100);
    let largePage = 0;
    const large = protocol(({ message }) =>
      wire(message.id, {
        tools: [
          upstreamTool(`large_${++largePage}`, {
            description: "x".repeat(900_000),
          }),
        ],
        nextCursor: `page-${largePage}`,
      }),
    );
    await expect(
      createRemoteMcpAdapter(large).resolveTools(source, owner),
    ).rejects.toMatchObject({
      code: "import_invalid",
      effect: { state: "not_dispatched" },
    });
  });
  it("fails the entire discovery on derived metadata above eight MiB without counting retained raw manifest twice", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, {
        tools: Array.from({ length: 500 }, (_, index) =>
          upstreamTool(`tool_${index}`),
        ),
      }),
    );
    const adapter = createRemoteMcpAdapter({
      transport: remote.transport,
      discoveryTransport: async () => remote.transport,
      describeAuthentication: async () => ({
        requirement: "remote",
        definition: {
          provider: "github",
          methods: ["bearer"],
          scopes: ["s".repeat(4096)],
          issuer: "i".repeat(4096),
          audience: "a".repeat(4096),
          tenant: "t".repeat(4096),
          application: "p".repeat(4096),
        },
      }),
    });
    await expect(
      adapter.resolveTools({ ...source, accountId }, owner),
    ).rejects.toMatchObject({
      name: "DerivedMetadataBudgetError",
      code: "import_invalid",
      status: 413,
    });
    expect(
      remote.exchanges.some(
        (exchange) => exchange.message.method === "tools/call",
      ),
    ).toBe(false);
    expect(remote.exchanges.at(-1)?.method).toBe("DELETE");
  });
});

describe("D12 remote invocation preservation, isolation and effect safety", () => {
  it("calls only the frozen upstream name using the Run broker and a new Account-isolated session each time", async () => {
    const remote = fixture();
    const adapter = createRemoteMcpAdapter(remote);
    for (const runId of ["run-one", "run-two"])
      await adapter.invokeTool({
        runId,
        claimId: runId,
        tool: frozen(),
        arguments: { value: "business" },
        deadlineMs: Date.now() + 5_000,
        broker: remote.broker,
      });
    const calls = remote.exchanges.filter(
      (exchange) => exchange.message.method === "tools/call",
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.message.params).toEqual({
        name: "get_me",
        arguments: { value: "business" },
      });
      expect(call.input).toMatchObject({
        accountRequirement: "remote",
        controlTraffic: false,
      });
      expect(new Headers(call.input.headers).get("authorization")).toBeNull();
    }
    expect(
      calls.map(
        (call) =>
          "trustedHeaders" in call.input &&
          call.input.trustedHeaders?.["mcp-session-id"],
      ),
    ).toEqual(["session-1", "session-2"]);
    for (const exchange of remote.exchanges.filter(
      (exchange) => exchange.message.method !== "tools/call",
    ))
      expect(exchange.input).toMatchObject({ controlTraffic: true });
    expect(
      remote.exchanges.some(
        (exchange) => exchange.message.method === "tools/list",
      ),
    ).toBe(false);
  });
  it("preserves text, structuredContent, upstream isError and safe third-party metadata", async () => {
    const native = {
      content: [{ type: "text", text: "provider failure details" }],
      structuredContent: { code: "rejected" },
      isError: true,
      _meta: { "org.example/context": { note: "safe" } },
    };
    const remote = protocol(({ message }) => wire(message.id, native));
    const response = await invoke(remote, remote.broker);
    expect(response.result).toEqual(native);
    expect(response.effect).toEqual({ state: "completed" });
    expect(response.effect.state).not.toBe("verified_no_effect");
  });
  it("redacts trusted credential values throughout result text, structured data and metadata", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, {
        content: [{ type: "text", text: "private-token" }],
        structuredContent: { nested: ["private-token"] },
        _meta: { "org.example/context": "private-token" },
      }),
    );
    const broker = {
      ...remote.broker,
      redact: (text: string) => text.replaceAll("private-token", "[redacted]"),
    };
    const response = await invoke(remote, broker);
    expect(JSON.stringify(response.result)).not.toContain("private-token");
    expect(response.result.structuredContent).toEqual({
      nested: ["[redacted]"],
    });
  });
  it("rejects reserved gateway metadata and retains post-dispatch uncertainty", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, {
        content: [{ type: "text", text: "effect happened" }],
        _meta: { "com.toolcontrolplane/execution": { run_id: "forged" } },
      }),
    );
    await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
      code: "metadata_collision",
      effect: { state: "possible" },
      retryable: false,
    });
    expect(
      remote.exchanges.filter(
        (exchange) => exchange.message.method === "tools/call",
      ),
    ).toHaveLength(1);
  });
  it.each(["image", "audio", "resource", "resource_link", "binary"])(
    "rejects unsupported %s content without dropping it or claiming no effect",
    async (type) => {
      const remote = protocol(({ message }) =>
        wire(message.id, {
          content: [
            { type: "text", text: "must not keep a subset" },
            { type, data: "unhandled" },
          ],
        }),
      );
      await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
        code: "unsupported_result",
        effect: { state: "possible" },
      });
    },
  );
  it("rejects native Task or interactive result extensions instead of pretending a Tool completed", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, { content: [], task: { taskId: "native-task" } }),
    );
    await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
  });
  it("validates declared output schemas before preserving a native result", async () => {
    const remote = protocol(({ message }) =>
      wire(message.id, { content: [], structuredContent: { value: 4 } }),
    );
    const tool = frozen();
    tool.definition.outputSchema = inputSchema;
    await expect(invoke(remote, remote.broker, tool)).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
  });
  it("rejects argument and _account injection before any session or business dispatch", async () => {
    const remote = fixture();
    await expect(
      invoke(remote, remote.broker, frozen(), { value: 3 }),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      effect: { state: "not_dispatched" },
    });
    await expect(
      invoke(remote, remote.broker, frozen(), { _account: "override" }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(remote.exchanges).toHaveLength(0);
  });
  it("never retries or reinitializes after an ambiguous business network loss or expired session", async () => {
    for (const loss of ["disconnect", "expired-session"]) {
      const remote = protocol(() => {
        if (loss === "disconnect")
          throw new Error("raw secret platform failure");
        return new Response("raw secret provider failure", { status: 404 });
      });
      await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
        effect: { state: "possible" },
        retryable: false,
      });
      expect(
        remote.exchanges.filter(
          (exchange) => exchange.message.method === "tools/call",
        ),
      ).toHaveLength(1);
      expect(
        remote.exchanges.filter(
          (exchange) => exchange.message.method === "initialize",
        ),
      ).toHaveLength(1);
    }
  });
  it("independent trusted effect evidence survives a malformed postwrite result", async () => {
    const remote = protocol(
      () =>
        new Response("malformed", {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      invoke(
        {
          ...remote,
          effectEvidence: () => ({
            state: "completed",
            providerRequestId: "trusted-request",
          }),
        },
        remote.broker,
      ),
    ).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "completed", providerRequestId: "trusted-request" },
    });
  });
  it("never treats JSON-RPC errors or unsupported HTTP media as independent no-effect evidence", async () => {
    for (const rejection of ["rpc", "media"]) {
      const remote = protocol(({ message }) =>
        rejection === "rpc"
          ? new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32603, message: "private upstream body" },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : new Response("private upstream body", {
              headers: { "content-type": "text/html" },
            }),
      );
      await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
        code: rejection === "rpc" ? "upstream_rejected" : "unsupported_result",
        effect: { state: "possible" },
        retryable: false,
      });
      expect(
        remote.exchanges.filter(
          (exchange) => exchange.message.method === "tools/call",
        ),
      ).toHaveLength(1);
    }
  });
  it("preserves a trusted broker pre-dispatch restriction error without trying another Account", async () => {
    const remote = fixture();
    const broker: RemoteBroker = {
      requestRaw: async (request) => {
        if (!request.controlTraffic)
          throw new RemoteMcpError(
            "account_disabled",
            "The selected Account is disabled.",
            {
              state: "verified_no_effect",
              reason: "Authority denied before send",
            },
          );
        return remote.respond(request);
      },
      effect: () => ({
        state: "verified_no_effect",
        reason: "Authority denied before send",
      }),
    };
    await expect(invoke(remote, broker)).rejects.toMatchObject({
      code: "account_disabled",
      effect: { state: "verified_no_effect" },
    });
    expect(
      remote.exchanges.some(
        (exchange) => exchange.message.method === "tools/call",
      ),
    ).toBe(false);
  });
  it("bounds the business response deadline and never retries an indefinite result", async () => {
    let cancelled = false;
    const remote = protocol(
      ({ message }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } })}\n\n`,
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(
      invoke(remote, remote.broker, frozen(), {}, Date.now() + 50),
    ).rejects.toMatchObject({
      code: "execution_timeout",
      effect: { state: "possible" },
    });
    expect(cancelled).toBe(true);
    expect(
      remote.exchanges.filter(
        (exchange) => exchange.message.method === "tools/call",
      ),
    ).toHaveLength(1);
  });
  it("bounds failed cleanup and does not replace an acknowledged business result", async () => {
    const remote = fixture(({ method, message }) => {
      if (method === "DELETE")
        throw new Error("cleanup failed with private session");
      if (message.method === "initialize") return initialized(message.id);
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return wire(message.id, { content: [{ type: "text", text: "done" }] });
    });
    expect((await invoke(remote, remote.broker)).result.content).toEqual([
      { type: "text", text: "done" },
    ]);
    expect(
      remote.exchanges.filter(
        (exchange) => exchange.message.method === "tools/call",
      ),
    ).toHaveLength(1);
  });
});

describe("D12 bounded single-result SSE and refused server capabilities", () => {
  it("accepts bounded finite SSE, multiline data and valid keepalive comments", async () => {
    const remote = protocol(
      ({ message }) =>
        new Response(
          `: keepalive\r\n\r\nevent: message\r\nid: no-resume\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":${JSON.stringify(message.id)},"result":{"content":[{"type":"text","text":"finite"}]}}\r\n\r\n`,
          { headers: { "content-type": "text/event-stream; charset=utf-8" } },
        ),
    );
    expect((await invoke(remote, remote.broker)).result.content[0]?.text).toBe(
      "finite",
    );
  });
  it("handles UTF-8 and CRLF split across individual wire chunks without reconnect semantics", async () => {
    const remote = protocol(({ message }) => {
      const bytes = new TextEncoder().encode(
        `: comment\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Unicode \u00e9" }] } })}\r\r`,
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect((await invoke(remote, remote.broker)).result.content[0]?.text).toBe(
      "Unicode \u00e9",
    );
  });
  it("accepts exactly one MiB of decoded event data without mistaking framing bytes for data", async () => {
    let characters = 0;
    const remote = protocol(({ message }) => {
      const result = { content: [{ type: "text", text: "" }] };
      const size = new TextEncoder().encode(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      ).length;
      characters = 1_048_576 - size;
      result.content[0]!.text = "x".repeat(characters);
      return sse(message.id, result);
    });
    expect(
      (await invoke(remote, remote.broker)).result.content[0]?.text.length,
    ).toBe(characters);
  });
  it.each([
    "sampling/createMessage",
    "elicitation/create",
    "roots/list",
    "tasks/get",
    "tasks/cancel",
  ])(
    "returns method-not-found for server %s and never forwards it to a caller",
    async (method) => {
      const remote = protocol(({ message }) =>
        sse(
          message.id,
          { content: [{ type: "text", text: "complete" }] },
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-request", method, params: {} })}\n\n`,
        ),
      );
      expect(
        (await invoke(remote, remote.broker)).result.content[0]?.text,
      ).toBe("complete");
      const refusal = remote.exchanges.find(
        (exchange) => "error" in exchange.message,
      );
      expect(refusal?.message).toEqual({
        jsonrpc: "2.0",
        id: "server-request",
        error: { code: -32601, message: "Client method not supported" },
      });
      expect(refusal?.input).toMatchObject({ controlTraffic: true });
    },
  );
  it("accepts exactly 64 framed events and rejects event 65 with the possible effect barrier", async () => {
    const accepted = protocol(({ message }) =>
      sse(message.id, { content: [] }, "id: ignored\n\n".repeat(63)),
    );
    expect((await invoke(accepted, accepted.broker)).result.content).toEqual(
      [],
    );
    const rejected = protocol(({ message }) =>
      sse(message.id, { content: [] }, "id: ignored\n\n".repeat(64)),
    );
    await expect(invoke(rejected, rejected.broker)).rejects.toMatchObject({
      code: "payload_too_large",
      effect: { state: "possible" },
    });
  });
  it.each([
    "wrong-id",
    "two-results",
    "unsupported-event",
    "notification",
    "truncated",
  ])("rejects unsupported SSE %s framing", async (mode) => {
    const remote = protocol(({ message }) => {
      if (mode === "wrong-id") return sse("other-request", { content: [] });
      if (mode === "two-results")
        return sse(
          message.id,
          { content: [] },
          "",
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } })}\n\n`,
        );
      if (mode === "unsupported-event")
        return sse(message.id, { content: [] }, "event: endpoint\n");
      if (mode === "notification")
        return sse(
          message.id,
          { content: [] },
          'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
        );
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } })}\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
  });
  it("rejects oversized decoded event data, malformed JSON, duplicate keys, nonfinite numbers and invalid Unicode", async () => {
    for (const malformed of [
      "{",
      '{"jsonrpc":"2.0","jsonrpc":"2.0","id":0,"result":{}}',
      '{"jsonrpc":"2.0","id":0,"result":{"content":[],"structuredContent":{"bad":1e999}}}',
      '{"jsonrpc":"2.0","id":0,"result":{"content":[{"type":"text","text":"\\ud800"}]}}',
    ]) {
      const remote = protocol(
        () =>
          new Response(`data: ${malformed}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
        code: "unsupported_result",
        effect: { state: "possible" },
      });
    }
    const large = protocol(({ message }) =>
      sse(message.id, {
        content: [{ type: "text", text: "x".repeat(1_048_576) }],
      }),
    );
    await expect(invoke(large, large.broker)).rejects.toMatchObject({
      code: "payload_too_large",
      effect: { state: "possible" },
    });
  });
  it("does not accept legacy SSE endpoint events, arbitrary JSON arrays or unestablished decoded encoding", async () => {
    for (const response of [
      new Response("event: endpoint\ndata: /messages\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
      new Response("[]", { headers: { "content-type": "application/json" } }),
      new Response("compressed-looking", {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
    ]) {
      const remote = protocol(() => response);
      await expect(invoke(remote, remote.broker)).rejects.toMatchObject({
        code: "unsupported_result",
        effect: { state: "possible" },
      });
    }
  });
});

describe("D12 staged manifest drift and retained revision availability", () => {
  it("classifies unchanged/new, description-only, schema drift, removal and rejected Tools without publishing", () => {
    const previous = [frozen().definition];
    expect(
      classifyRemoteManifestDrift(previous, {
        accepted: previous,
        rejected: [],
      }).oldAvailability,
    ).toEqual([
      { tool: "github.get_me", available: true, classification: "unchanged" },
    ]);
    const description = {
      ...previous[0]!,
      description: "Owner must review this description",
    };
    expect(
      classifyRemoteManifestDrift(previous, {
        accepted: [description],
        rejected: [],
      }),
    ).toMatchObject({
      changes: [{ tool: "github.get_me", kind: "changed" }],
      oldAvailability: [
        { available: true, classification: "annotation_drift" },
      ],
      implementationPinned: false,
    });
    const changed = {
      ...previous[0]!,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
    expect(
      classifyRemoteManifestDrift(previous, {
        accepted: [changed],
        rejected: [],
      }).oldAvailability,
    ).toEqual([
      {
        tool: "github.get_me",
        available: false,
        classification: "contract_drift",
      },
    ]);
    expect(
      classifyRemoteManifestDrift(previous, { accepted: [], rejected: [] })
        .oldAvailability[0],
    ).toMatchObject({ available: false, classification: "removed" });
    expect(
      classifyRemoteManifestDrift(previous, {
        accepted: [],
        rejected: [
          {
            upstreamName: "get_me",
            path: "/tools/0",
            code: "unsupported_schema",
            message: "Unsupported schema",
          },
        ],
      }).oldAvailability[0],
    ).toMatchObject({ available: false, classification: "rejected" });
    const fresh = { ...previous[0]!, name: "github.new_tool" };
    expect(
      classifyRemoteManifestDrift(previous, {
        accepted: [...previous, fresh],
        rejected: [],
      }).changes,
    ).toContainEqual({ tool: "github.new_tool", kind: "new" });
    expect(previous[0]?.description).toBe("Read identity");
  });
});
