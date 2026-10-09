import { readFile } from "node:fs/promises";
import { createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import type {
  FrozenTool,
  HttpParameter,
  JSONSchema,
  JSONValue,
  OpenApiSource,
  Requirement,
  ToolDefinition,
} from "@scaffold/schema/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccountsService } from "../src/integrations/accounts";
import {
  type ArtifactRunContext,
  createArtifactsService,
} from "../src/integrations/artifacts";
import { createBroker } from "../src/integrations/broker";
import { DerivedMetadataBudgetError } from "../src/integrations/derived-budget";
import {
  httpInputSchema,
  invokeHttpTool,
  normalizeHttpTool,
  resolveHttpTools,
  serializeHttpArguments,
  validateHttpArtifactInputs,
} from "../src/integrations/http";
import { resolveOpenApiTools } from "../src/integrations/openapi";
import { createGithubProvider } from "../src/integrations/providers/github";
import {
  parseSourceDocument,
  resolveReferences,
} from "../src/integrations/reference-resolver";
import { validateInput } from "../src/integrations/schema";
import {
  type HttpTransport,
  type HttpTransportInput,
  TransportError,
} from "../src/integrations/transport";

// The controlled transport never dials this public documentation hostname.
// Reserved .test targets are correctly denied by the production URL guard.
const origin = "https://api.example.com";
const objectSchema: JSONSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
function definition(
  parameters: HttpParameter[] = [],
  requestBody?: Extract<
    ToolDefinition["implementation"],
    { kind: "http" }
  >["requestBody"],
): ToolDefinition {
  const implementation: Extract<
    ToolDefinition["implementation"],
    { kind: "http" }
  > = {
    kind: "http",
    method: requestBody ? "POST" : "GET",
    url: `${origin}/records${parameters.some((p) => p.in === "path") ? "/{id}" : ""}`,
    parameters,
    ...(requestBody ? { requestBody } : {}),
    response: {
      mediaType: "application/json",
      schema: objectSchema,
      statuses: {
        "200": { mediaType: "application/json", schema: objectSchema },
      },
    },
  };
  return {
    name: "sample.records",
    description: "Public fixture",
    operationClass: "unknown",
    requirements: {},
    permissions: [
      {
        requirement: null,
        origin,
        methods: [implementation.method],
        path: "/records",
        match: "prefix",
      },
    ],
    inputSchema: httpInputSchema(implementation),
    implementation,
  };
}
function parameter(
  name: string,
  location: HttpParameter["in"],
  schema: JSONSchema,
  explode = location === "query",
  required = false,
): HttpParameter {
  return {
    name,
    in: location,
    schema,
    style: location === "query" ? "form" : "simple",
    explode,
    required: location === "path" || required,
  };
}
function openapi(
  paths: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): OpenApiSource {
  return {
    kind: "openapi",
    document: JSON.stringify({
      openapi: "3.1.1",
      info: { title: "Public fixture", version: "1" },
      servers: [{ url: origin }],
      paths,
      ...extras,
    }),
    approvedRefOrigins: [],
    nameMapping: {},
    securityMappings: {},
    operationOptions: {},
  };
}
function operation(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operationId: "records",
    responses: {
      "200": {
        description: "Success",
        content: { "application/json": { schema: objectSchema } },
      },
    },
    ...extra,
  };
}
function frozen(tool: ToolDefinition): FrozenTool {
  return {
    toolId: "00000000-0000-4000-8000-000000000011",
    name: tool.name,
    toolRevision: "public-tool-v1",
    integrationId: "00000000-0000-4000-8000-000000000012",
    integrationRevision: "public-integration-v1",
    artifactDigest: "a".repeat(64),
    definition: tool,
  };
}

describe("M2 safe document and restricted reference snapshots", () => {
  it("reads strict JSON and safe block/flow YAML", () => {
    expect(parseSourceDocument('{"openapi":"3.1.1"}')).toEqual({
      openapi: "3.1.1",
    });
    expect(parseSourceDocument("openapi: 3.1.1\npaths: {}\n")).toEqual({
      openapi: "3.1.1",
      paths: {},
    });
    expect(parseSourceDocument("{openapi: 3.1.1, paths: {}}")).toEqual({
      openapi: "3.1.1",
      paths: {},
    });
  });
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    "a: 1\na: 2",
    "a: &anchor 1\nb: *anchor",
    "a: !!str tagged",
    "a: !custom x",
    "a: {<<: {b: 1}}",
    "a: .inf",
    '{"a":"\\ud800"}',
    '{"a":1e999}',
  ])("rejects unsafe document %s", (text) => {
    expect(() => parseSourceDocument(text)).toThrow();
  });
  it("counts actual bytes rather than document character length", () => {
    expect(() => parseSourceDocument(`a: '${"😀".repeat(1310721)}'`)).toThrow();
  });
  it("resolves local and approved credential-free remote JSON pointers once into immutable snapshots", async () => {
    const requests: HttpTransportInput[] = [];
    let content = '{"value":{"type":"integer","minimum":1}}';
    const transport: HttpTransport = {
      async request(input) {
        requests.push(input);
        return new Response(content);
      },
    };
    const root = JSON.stringify({
      openapi: "3.1.1",
      first: { $ref: "https://refs.public-example.test/types.json#/value" },
      second: { $ref: "https://refs.public-example.test/types.json#/value" },
    });
    const result = await resolveReferences(root, {
      transport,
      approvedOrigins: ["https://refs.public-example.test"],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.has("authorization")).toBe(false);
    expect(requests[0]!.headers.has("cookie")).toBe(false);
    expect(result.documents).toHaveLength(2);
    expect(result.documents[1]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.references).toHaveLength(2);
    content = '{"value":{"type":"integer","minimum":100}}';
    expect((result.document.first as Record<string, unknown>).minimum).toBe(1);
  });
  it("uses redirected document URL as the base for relative references", async () => {
    const seen: string[] = [];
    const transport: HttpTransport = {
      async request(input) {
        seen.push(input.url);
        if (input.url.endsWith("/start.json"))
          return new Response(null, {
            status: 302,
            headers: { location: "/nested/target.json" },
          });
        if (input.url.endsWith("/nested/target.json"))
          return new Response('{"value":{"$ref":"type.json#/value"}}');
        return new Response('{"value":{"type":"string"}}');
      },
    };
    const result = await resolveReferences(
      '{"openapi":"3.1.1","value":{"$ref":"https://refs.public-example.test/start.json#/value"}}',
      { transport, approvedOrigins: ["https://refs.public-example.test"] },
    );
    expect(seen).toEqual([
      "https://refs.public-example.test/start.json",
      "https://refs.public-example.test/nested/target.json",
      "https://refs.public-example.test/nested/type.json",
    ]);
    expect(result.document.value).toEqual({ type: "string" });
  });
  it("rejects unapproved redirect transitions before connecting", async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async request() {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://private-other.test/spec.json" },
        });
      },
    };
    await expect(
      resolveReferences(
        '{"openapi":"3.1.1","x":{"$ref":"https://refs.public-example.test/spec.json"}}',
        { transport, approvedOrigins: ["https://refs.public-example.test"] },
      ),
    ).rejects.toMatchObject({ code: "reference_forbidden" });
    expect(calls).toBe(1);
  });
  it("does not retry reference failures and limits three redirects", async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async request() {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "/loop.json" },
        });
      },
    };
    await expect(
      resolveReferences(
        '{"openapi":"3.1.1","x":{"$ref":"https://refs.public-example.test/spec.json"}}',
        { transport, approvedOrigins: ["https://refs.public-example.test"] },
      ),
    ).rejects.toMatchObject({ code: "reference_limit" });
    expect(calls).toBe(4);
  });
  it("rejects cyclic graphs, missing pointers, and eleven-deep dereference chains", async () => {
    await expect(
      resolveReferences('{"openapi":"3.1.1","a":{"$ref":"#/a"}}', {
        approvedOrigins: [],
      }),
    ).rejects.toMatchObject({ code: "import_invalid" });
    await expect(
      resolveReferences('{"openapi":"3.1.1","a":{"$ref":"#/missing"}}', {
        approvedOrigins: [],
      }),
    ).rejects.toMatchObject({ code: "import_invalid" });
    const root: Record<string, unknown> = { openapi: "3.1.1" };
    for (let i = 0; i < 11; i++) root[`r${i}`] = { $ref: `#/r${i + 1}` };
    root.r11 = { type: "string" };
    await expect(
      resolveReferences(JSON.stringify(root), { approvedOrigins: [] }),
    ).rejects.toMatchObject({ code: "reference_limit" });
  });
  it("rejects more than a thousand reference occurrences", async () => {
    await expect(
      resolveReferences(
        JSON.stringify({
          openapi: "3.1.1",
          type: { type: "string" },
          refs: Array.from({ length: 1001 }, () => ({ $ref: "#/type" })),
        }),
        { approvedOrigins: [] },
      ),
    ).rejects.toMatchObject({ code: "reference_limit" });
  });
  it("counts unique source reference occurrences while memoizing shared targets without bypassing depth", async () => {
    const root = {
      openapi: "3.1.1",
      leaf: { type: "string" },
      shared: { $ref: "#/leaf" },
      refs: Array.from({ length: 999 }, () => ({ $ref: "#/shared" })),
    };
    expect(
      (await resolveReferences(JSON.stringify(root), { approvedOrigins: [] }))
        .references,
    ).toHaveLength(1000);
    const deep: Record<string, unknown> = {
      openapi: "3.1.1",
      r10: { type: "string" },
    };
    for (let index = 9; index >= 0; index--)
      deep[`r${index}`] = { $ref: `#/r${index + 1}` };
    expect(
      (await resolveReferences(JSON.stringify(deep), { approvedOrigins: [] }))
        .document.r0,
    ).toEqual({ type: "string" });
  });
  it("preserves inert example/default/extension references without network interpretation", async () => {
    const result = await resolveReferences(
      JSON.stringify({
        openapi: "3.1.1",
        example: { $ref: "https://unapproved.test/no-fetch" },
        default: { $ref: "https://unapproved.test/no-fetch" },
        "x-annotation": { $ref: "https://unapproved.test/no-fetch" },
        properties: { "x-property": { $ref: "#/schema" } },
        schema: { type: "string" },
      }),
      { approvedOrigins: [] },
    );
    expect(result.documents).toHaveLength(1);
    expect(result.references).toHaveLength(1);
    expect((result.document.example as Record<string, unknown>).$ref).toBe(
      "https://unapproved.test/no-fetch",
    );
  });
  it("enforces the distinct document cap including root and decoded document bytes", async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async request() {
        calls++;
        return new Response('{"schema":{"type":"string"}}');
      },
    };
    const root = {
      openapi: "3.1.1",
      refs: Array.from({ length: 16 }, (_, index) => ({
        $ref: `https://refs.public-example.test/${index}.json#/schema`,
      })),
    };
    await expect(
      resolveReferences(JSON.stringify(root), {
        transport,
        approvedOrigins: ["https://refs.public-example.test"],
      }),
    ).rejects.toMatchObject({ code: "reference_limit" });
    expect(calls).toBe(15);
    await expect(
      resolveReferences(
        '{"openapi":"3.1.1","schema":{"$ref":"https://refs.public-example.test/large.json"}}',
        {
          transport: {
            async request() {
              return new Response("x".repeat(5242881));
            },
          },
          approvedOrigins: ["https://refs.public-example.test"],
        },
      ),
    ).rejects.toMatchObject({ code: "reference_limit" });
  });
  it("cancels an indefinitely incomplete reference body on the owner resolution signal", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const transport: HttpTransport = {
      async request() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"type":"string"}'));
              queueMicrotask(() => controller.abort());
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    };
    await expect(
      resolveReferences(
        '{"openapi":"3.1.1","schema":{"$ref":"https://refs.public-example.test/infinite.json"}}',
        {
          transport,
          signal: controller.signal,
          approvedOrigins: ["https://refs.public-example.test"],
        },
      ),
    ).rejects.toMatchObject({ code: "reference_limit" });
    expect(cancelled).toBe(true);
  });
});

describe("M2 OpenAPI operation subset and explicit review", () => {
  it.each(["3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.1.0", "3.1.1"])(
    "accepts declared version %s",
    async (version) => {
      const source = openapi(
        { "/records": { get: operation() } },
        { openapi: version },
      );
      const result = await resolveOpenApiTools(source, { slug: "sample" });
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0]!.operationClass).toBe("unknown");
    },
  );
  it.each(["2.0", "3.0.4", "3.1.2", "3.2.0"])(
    "rejects unknown version %s",
    async (version) => {
      await expect(
        resolveOpenApiTools(openapi({}, { openapi: version }), {
          slug: "sample",
        }),
      ).rejects.toMatchObject({ code: "import_invalid" });
    },
  );
  it("keeps supported operations unpublished while reporting unsupported entries", async () => {
    const result = await resolveOpenApiTools(
      openapi({
        "/records": {
          get: operation(),
          trace: operation({ operationId: "trace" }),
          post: operation({
            operationId: "bad",
            parameters: [
              {
                in: "query",
                name: "nested",
                schema: { type: "object" },
                style: "deepObject",
              },
            ],
          }),
        },
      }),
      { slug: "sample" },
    );
    expect(result.accepted.map((tool) => tool.name)).toEqual([
      "sample.records",
    ]);
    expect(result.rejected).toHaveLength(2);
    expect(
      result.rejected.every((entry) => entry.path.startsWith("/paths/")),
    ).toBe(true);
  });
  it("counts unsupported operations against the 500 operation cap", async () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 501; i++)
      paths[`/r${i}`] = { trace: operation({ operationId: `r${i}` }) };
    await expect(
      resolveOpenApiTools(openapi(paths), { slug: "sample" }),
    ).rejects.toMatchObject({ code: "reference_limit" });
  });
  it("bounds expanded shared-schema metadata incrementally without counting raw document snapshots", async () => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 70; index++) {
      paths[`/r${index}`] = {
        get: operation({
          operationId: `r${index}`,
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Common" },
                },
              },
            },
          },
        }),
      };
    }
    const common = {
      ...objectSchema,
      "x-public-review-note": "a".repeat(65536),
    };
    await expect(
      resolveOpenApiTools(
        openapi(paths, { components: { schemas: { Common: common } } }),
        { slug: "sample" },
      ),
    ).rejects.toBeInstanceOf(DerivedMetadataBudgetError);
    const result = await resolveOpenApiTools(
      openapi(
        { "/records": { get: operation() } },
        { "x-unused-snapshot-note": "a".repeat(4194304) },
      ),
      { slug: "sample" },
    );
    expect(result.accepted).toHaveLength(1);
  });
  it("requires explicit server selection and never invents a default URL", async () => {
    const none = await resolveOpenApiTools(
      openapi({ "/records": { get: operation() } }, { servers: [] }),
      { slug: "sample" },
    );
    expect(none.accepted).toHaveLength(0);
    const source = openapi(
      { "/records": { get: operation() } },
      {
        servers: [
          { url: origin },
          { url: "https://other.public-example.test" },
        ],
      },
    );
    expect(
      (await resolveOpenApiTools(source, { slug: "sample" })).rejected,
    ).toHaveLength(1);
    source.serverUrl = origin;
    expect(
      (await resolveOpenApiTools(source, { slug: "sample" })).accepted,
    ).toHaveLength(1);
  });
  it("requires explicitly validated server variables", async () => {
    const source = openapi(
      { "/records": { get: operation() } },
      {
        servers: [
          {
            url: "https://{region}.public-example.test",
            variables: { region: { default: "west", enum: ["west", "east"] } },
          },
        ],
      },
    );
    expect(
      (await resolveOpenApiTools(source, { slug: "sample" })).rejected,
    ).toHaveLength(1);
    source.serverUrl = "https://east.public-example.test";
    expect(
      (await resolveOpenApiTools(source, { slug: "sample" })).accepted,
    ).toHaveLength(1);
    source.serverUrl = "https://unauthorized.public-example.test";
    expect(
      (await resolveOpenApiTools(source, { slug: "sample" })).rejected,
    ).toHaveLength(1);
  });
  it("honors operation parameter overrides and case-insensitive header identity", async () => {
    const source = openapi({
      "/records/{id}": {
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "integer", minimum: 1 },
          },
          { in: "header", name: "X-Revision", schema: { type: "string" } },
        ],
        get: operation({
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "integer", minimum: 0 },
            },
            { in: "header", name: "x-revision", schema: { type: "integer" } },
          ],
        }),
      },
    });
    const tool = (await resolveOpenApiTools(source, { slug: "sample" }))
      .accepted[0];
    if (!tool) throw new Error("Expected accepted HTTP Tool");
    const request = serializeHttpArguments(tool, {
      path: { id: 0 },
      headers: { "x-revision": 0 },
    });
    expect(request.url).toBe(`${origin}/records/0`);
    expect(request.headers["x-revision"]).toBe("0");
  });
  it("rejects root security errors as whole imports", async () => {
    await expect(
      resolveOpenApiTools(
        openapi(
          { "/records": { get: operation() } },
          { security: { bad: [] } },
        ),
        { slug: "sample" },
      ),
    ).rejects.toMatchObject({ code: "import_invalid" });
  });
  it("preserves AND requirements and explicit OR selection without taking unauthenticated alternatives", async () => {
    const source = openapi(
      { "/records": { get: operation() } },
      {
        security: [{ first: [], second: [] }, {}],
        components: {
          securitySchemes: {
            first: { type: "http", scheme: "bearer" },
            second: { type: "apiKey", in: "header", name: "X-Provider-Key" },
          },
        },
      },
    );
    source.securityMappings = {
      first: {
        requirement: "primary",
        requirementDefinition: {
          provider: "fixture",
          methods: ["bearer"],
          scopes: [],
        },
      },
      second: {
        requirement: "secondary",
        requirementDefinition: {
          provider: "fixture",
          methods: ["api_key"],
          scopes: [],
        },
      },
    };
    const context = {
      slug: "sample",
      validateSecurityMapping(
        scheme: Record<string, unknown>,
        requirement: Requirement,
      ) {
        if (
          requirement.provider !== "fixture" ||
          !["http", "apiKey"].includes(scheme.type as string)
        )
          throw new Error("Unsupported fixture adapter");
      },
    };
    expect((await resolveOpenApiTools(source, context)).rejected).toHaveLength(
      1,
    );
    source.operationOptions.records = { securityAlternative: 0 };
    const secured = (await resolveOpenApiTools(source, context)).accepted[0];
    if (!secured) throw new Error("Expected accepted secured Tool");
    expect(Object.keys(secured.requirements)).toEqual(["primary", "secondary"]);
    expect(
      secured.permissions.map((permission) => permission.requirement),
    ).toEqual(["primary", "secondary"]);
    source.operationOptions.records.securityAlternative = 1;
    expect(
      Object.keys(
        (await resolveOpenApiTools(source, context)).accepted[0]!.requirements,
      ),
    ).toHaveLength(0);
  });
  it("rejects colliding AND authentication headers instead of publishing an unusable Tool", async () => {
    const declarations = [
      {
        first: { type: "http", scheme: "bearer" },
        second: { type: "http", scheme: "basic" },
      },
      {
        first: { type: "apiKey", in: "header", name: "X-Provider-Key" },
        second: { type: "apiKey", in: "header", name: "x-provider-key" },
      },
    ];
    for (const schemes of declarations) {
      const source = openapi(
        { "/records": { get: operation() } },
        {
          security: [{ first: [], second: [] }],
          components: { securitySchemes: schemes },
        },
      );
      source.securityMappings = {
        first: {
          requirement: "primary",
          requirementDefinition: {
            provider: "fixture",
            methods: [schemes.first.type === "http" ? "bearer" : "api_key"],
            scopes: [],
          },
        },
        second: {
          requirement: "secondary",
          requirementDefinition: {
            provider: "fixture",
            methods: [schemes.second.type === "http" ? "basic" : "api_key"],
            scopes: [],
          },
        },
      };
      const result = await resolveOpenApiTools(source, {
        slug: "sample",
        validateSecurityMapping(scheme, requirement) {
          const method =
            scheme.type === "http" &&
            ["bearer", "basic"].includes(scheme.scheme as string)
              ? scheme.scheme
              : scheme.type === "apiKey" &&
                  scheme.in === "header" &&
                  (scheme.name as string).toLowerCase() === "x-provider-key"
                ? "api_key"
                : null;
          if (
            requirement.provider !== "fixture" ||
            requirement.methods.length !== 1 ||
            requirement.methods[0] !== method
          )
            throw new Error("Trusted fixture injection mismatch");
        },
      });
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]).toMatchObject({
        code: "unsupported_feature",
        path: "/security",
        message:
          "Selected AND security schemes collide on their authentication injection header",
      });
    }
  });
  it("requires a real trusted mapping validator and rejects query/cookie API key schemes", async () => {
    const source = openapi(
      { "/records": { get: operation() } },
      {
        security: [{ key: [] }],
        components: {
          securitySchemes: {
            key: { type: "apiKey", in: "query", name: "api_key" },
          },
        },
      },
    );
    source.securityMappings.key = {
      requirement: "key",
      requirementDefinition: {
        provider: "fixture",
        methods: ["api_key"],
        scopes: [],
      },
    };
    expect(
      (await resolveOpenApiTools(source, { slug: "sample" })).rejected,
    ).toHaveLength(1);
  });
  it("preserves request/schema constraints across 3.1 reference siblings", async () => {
    const source = openapi(
      {
        "/records": {
          get: operation({
            parameters: [
              {
                in: "query",
                name: "count",
                schema: {
                  $ref: "#/components/schemas/Count",
                  minimum: 2,
                  allOf: [{ maximum: 4 }],
                },
              },
            ],
          }),
        },
      },
      { components: { schemas: { Count: { type: "integer", minimum: 1 } } } },
    );
    const tool = (await resolveOpenApiTools(source, { slug: "sample" }))
      .accepted[0];
    if (!tool) throw new Error("Expected accepted HTTP Tool");
    expect(validateInput(tool.inputSchema, { query: { count: 2 } }).valid).toBe(
      true,
    );
    expect(validateInput(tool.inputSchema, { query: { count: 1 } }).valid).toBe(
      false,
    );
    expect(validateInput(tool.inputSchema, { query: { count: 5 } }).valid).toBe(
      false,
    );
  });
  it("rejects unsupported schema constraints without stripping them", async () => {
    const result = await resolveOpenApiTools(
      openapi({
        "/records": {
          get: operation({
            parameters: [
              {
                in: "query",
                name: "count",
                schema: { type: "integer", not: { const: 1 } },
              },
            ],
          }),
        },
      }),
      { slug: "sample" },
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.code).toBe("unsupported_schema");
    expect(result.accepted).toHaveLength(0);
  });
  it("keeps exact selected status and media schemas in the frozen definition", async () => {
    const source = openapi({
      "/records": {
        get: operation({
          responses: {
            "200": {
              description: "JSON",
              content: {
                "application/json": { schema: objectSchema },
                "text/plain": { schema: { type: "string" } },
              },
            },
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "integer" } },
                },
              },
            },
            default: {
              description: "Default",
              content: { "application/json": { schema: { type: "boolean" } } },
            },
          },
        }),
      },
    });
    expect(
      (await resolveOpenApiTools(source, { slug: "sample" })).rejected,
    ).toHaveLength(1);
    source.operationOptions.records = { responseMediaType: "application/json" };
    const result = await resolveOpenApiTools(source, { slug: "sample" });
    expect(result.accepted).toHaveLength(1);
    const implementation = result.accepted[0]!.implementation;
    expect(implementation.kind).toBe("http");
    if (implementation.kind !== "http") throw new Error();
    expect(Object.keys(implementation.response.statuses!)).toEqual([
      "200",
      "201",
      "default",
    ]);
    expect(result.manifest.excluded).toContainEqual({
      path: "/paths/~1records/get/responses/200/content",
      mediaType: "text/plain",
    });
  });
  it("rebases verified discriminator branches when schemas become Tool body wrappers", async () => {
    const cat = {
      type: "object",
      properties: {
        kind: { const: "cat", type: "string" },
        lives: { type: "integer", minimum: 1 },
      },
      required: ["kind", "lives"],
      additionalProperties: false,
    };
    const dog = {
      type: "object",
      properties: {
        kind: { const: "dog", type: "string" },
        barks: { type: "boolean" },
      },
      required: ["kind", "barks"],
      additionalProperties: false,
    };
    const source = openapi(
      {
        "/records": {
          post: operation({
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/Cat" },
                      { $ref: "#/components/schemas/Dog" },
                    ],
                    discriminator: {
                      propertyName: "kind",
                      mapping: {
                        cat: "#/components/schemas/Cat",
                        dog: "#/components/schemas/Dog",
                      },
                    },
                  },
                },
              },
            },
          }),
        },
      },
      { components: { schemas: { Cat: cat, Dog: dog } } },
    );
    const result = await resolveOpenApiTools(source, { slug: "sample" });
    expect(result.rejected).toHaveLength(0);
    const tool = result.accepted[0];
    if (!tool) throw new Error("Expected accepted HTTP Tool");
    expect(
      validateInput(tool.inputSchema, { body: { kind: "cat", lives: 9 } })
        .valid,
    ).toBe(true);
    expect(
      validateInput(tool.inputSchema, { body: { kind: "dog", barks: false } })
        .valid,
    ).toBe(true);
    expect(
      validateInput(tool.inputSchema, { body: { kind: "cat", lives: 0 } })
        .valid,
    ).toBe(false);
    expect(
      validateInput(tool.inputSchema, { body: { kind: "cat", barks: true } })
        .valid,
    ).toBe(false);
  });
  it("maps multipart binary schemas to structural authorized artifact inputs without losing constraints", async () => {
    const source = openapi({
      "/records": {
        post: operation({
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    files: {
                      type: "array",
                      items: { type: "string", format: "binary" },
                    },
                  },
                  required: ["file"],
                  additionalProperties: false,
                },
              },
            },
          },
        }),
      },
    });
    const result = await resolveOpenApiTools(source, { slug: "sample" });
    expect(result.accepted).toHaveLength(1);
    const tool = result.accepted[0]!;
    expect(
      validateInput(tool.inputSchema, {
        body: { file: { artifact_id: "00000000-0000-4000-8000-000000000001" } },
      }).valid,
    ).toBe(true);
    expect(
      validateInput(tool.inputSchema, {
        body: {
          file: {
            artifact_id: "00000000-0000-4000-8000-000000000001",
            filename: "caller-metadata",
          },
        },
      }).valid,
    ).toBe(false);
  });
  it("exposes excluded media and schema warnings as nonblocking source diagnostics, never rejected Tools", async () => {
    const source = openapi({
      "/records": {
        get: operation({
          parameters: [
            {
              in: "query",
              name: "count",
              schema: { type: "integer", default: "public-invalid-annotation" },
            },
          ],
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": { schema: objectSchema },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
          },
        }),
      },
    });
    const result = await resolveOpenApiTools(source, { slug: "sample" });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.diagnostics).toContainEqual({
      upstreamName: "records",
      path: "/paths/~1records/get/responses/200/content/text~1event-stream",
      code: "excluded_media",
      message:
        "This media alternative was excluded from the accepted operation's reviewed request or response contract.",
    });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.code === "schema_warning" &&
          entry.path.startsWith("/paths/~1records/get/parameters/0/schema"),
      ),
    ).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "public-invalid-annotation",
    );
  });
  it("allows only explicitly reviewed Bearer-compatible acquisition methods and preserves OAuth scopes", async () => {
    const source = openapi(
      { "/records": { get: operation() } },
      {
        security: [{ bearer: [] }],
        components: {
          securitySchemes: {
            bearer: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "annotation",
            },
          },
        },
      },
    );
    source.securityMappings.bearer = {
      requirement: "source",
      requirementDefinition: {
        provider: "fixture",
        methods: ["oauth2"],
        scopes: [],
      },
    };
    const context = {
      slug: "sample",
      validateSecurityMapping(
        scheme: Record<string, unknown>,
        requirement: Requirement,
      ) {
        if (
          scheme.type !== "http" ||
          requirement.methods.some(
            (method) => method !== "bearer" && method !== "oauth2",
          )
        )
          throw new Error("Trusted fixture wire mismatch");
      },
    };
    expect(
      (await resolveOpenApiTools(source, context)).accepted[0]!.requirements
        .source!.methods,
    ).toEqual(["oauth2"]);
    source.securityMappings.bearer.requirementDefinition.methods = [
      "bearer",
      "oauth2",
    ];
    expect((await resolveOpenApiTools(source, context)).accepted).toHaveLength(
      1,
    );
    source.securityMappings.bearer.requirementDefinition.methods = [
      "bearer",
      "none",
    ];
    expect((await resolveOpenApiTools(source, context)).rejected).toHaveLength(
      1,
    );
    const oauth = openapi(
      { "/records": { get: operation() } },
      {
        security: [{ native: ["read"] }],
        components: {
          securitySchemes: {
            native: {
              type: "oauth2",
              flows: {
                authorizationCode: {
                  authorizationUrl:
                    "https://registered.public-example.test/authorize",
                  tokenUrl: "https://registered.public-example.test/token",
                  scopes: { read: "Read" },
                },
              },
            },
          },
        },
      },
    );
    oauth.securityMappings.native = {
      requirement: "source",
      requirementDefinition: {
        provider: "fixture",
        methods: ["oauth2"],
        scopes: ["notify"],
      },
    };
    const result = await resolveOpenApiTools(oauth, {
      slug: "sample",
      validateSecurityMapping(scheme, requirement) {
        if (
          scheme.type !== "oauth2" ||
          requirement.methods[0] !== "oauth2" ||
          requirement.scopes.join(",") !== "notify,read"
        )
          throw new Error("Trusted fixture registration mismatch");
      },
    });
    expect(result.accepted[0]!.requirements.source!.scopes).toEqual([
      "notify",
      "read",
    ]);
  });
});

describe("M2 deterministic HTTP serialization with the real schema validator", () => {
  it("rejects a whole manual HTTP source when generated Tool metadata crosses the shared derived budget", () => {
    const bodySchema: JSONSchema = {
      ...objectSchema,
      "x-public-review-note": "a".repeat(65536),
    };
    const tools = Array.from({ length: 70 }, (_, index) => {
      const tool = definition([], {
        mediaType: "application/json",
        schema: bodySchema,
      });
      tool.name = `sample.r${index}`;
      return tool;
    });
    expect(() => resolveHttpTools({ kind: "http", tools })).toThrow(
      DerivedMetadataBudgetError,
    );
  });
  it("encodes scalars once, preserves false/zero/empty and repeats form query arrays", () => {
    const tool = normalizeHttpTool(
      definition([
        parameter("id", "path", { type: "string" }),
        parameter("q", "query", { type: "string" }),
        parameter("tags", "query", {
          type: "array",
          items: { type: "string" },
        }),
        parameter("count", "query", { type: "integer" }, true, true),
        parameter("flag", "query", { type: "boolean" }),
        parameter("empty", "query", { type: "string" }),
      ]),
    ).tool;
    const request = serializeHttpArguments(tool, {
      path: { id: "a%20b" },
      query: { q: "a b/+", tags: ["a", "b"], count: 0, flag: false, empty: "" },
    });
    expect(request.url).toBe(
      `${origin}/records/a%2520b?q=a%20b%2F%2B&tags=a&tags=b&count=0&flag=false&empty=`,
    );
  });
  it("serializes non-exploded query arrays and flat objects in schema ordering", () => {
    const tool = definition([
      parameter(
        "tags",
        "query",
        { type: "array", items: { type: "string" } },
        false,
      ),
      parameter(
        "meta",
        "query",
        {
          type: "object",
          properties: { b: { type: "integer" }, a: { type: "integer" } },
          additionalProperties: false,
        },
        false,
      ),
    ]);
    expect(
      serializeHttpArguments(tool, {
        query: { tags: ["a", "b"], meta: { a: 1, b: 2 } },
      }).url,
    ).toBe(`${origin}/records?tags=a,b&meta=b,2,a,1`);
  });
  it("never drops permitted additional flat object properties", () => {
    const tool = definition([
      parameter(
        "meta",
        "query",
        { type: "object", properties: { known: { type: "string" } } },
        false,
      ),
    ]);
    expect(
      serializeHttpArguments(tool, {
        query: { meta: { z: "z", known: "k", a: "a" } },
      }).url,
    ).toBe(`${origin}/records?meta=known,k,a,a,z,z`);
  });
  it("rejects expanded query collisions, arbitrary arguments, path traversal and header injection", () => {
    const collisions = definition([
      parameter(
        "meta",
        "query",
        {
          type: "object",
          properties: { q: { type: "string" } },
          additionalProperties: false,
        },
        true,
      ),
      parameter("q", "query", { type: "string" }),
    ]);
    expect(() =>
      serializeHttpArguments(collisions, {
        query: { meta: { q: "x" }, q: "y" },
      }),
    ).toThrow();
    expect(() =>
      serializeHttpArguments(definition(), { url: "https://private.test" }),
    ).toThrow();
    const paths = definition([parameter("id", "path", { type: "string" })]);
    for (const id of ["../", "/", "..", "\\"])
      expect(() => serializeHttpArguments(paths, { path: { id } })).toThrow();
    const headers = definition([
      parameter("X-Data", "header", { type: "string" }),
    ]);
    expect(() =>
      serializeHttpArguments(headers, {
        headers: { "X-Data": "x\r\nAuthorization: bad" },
      }),
    ).toThrow();
  });
  it("rejects manual forbidden headers and GET/HEAD request bodies through the same normalization path", () => {
    const headers = resolveHttpTools({
      kind: "http",
      tools: [
        definition([parameter("Authorization", "header", { type: "string" })]),
      ],
    });
    expect(headers.rejected).toHaveLength(1);
    const tool = definition([], {
      mediaType: "application/json",
      schema: { type: "object" },
    });
    if (tool.implementation.kind === "http") tool.implementation.method = "GET";
    expect(
      resolveHttpTools({ kind: "http", tools: [tool] }).rejected,
    ).toHaveLength(1);
  });
  it("maps text and form bodies without coercion or query-style encoding", () => {
    const form = definition([], {
      mediaType: "application/x-www-form-urlencoded",
      schema: {
        type: "object",
        properties: {
          q: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      required: true,
    });
    expect(
      new TextDecoder().decode(
        serializeHttpArguments(form, { body: { q: "a b/+", tags: ["a", "b"] } })
          .body,
      ),
    ).toBe("q=a+b%2F%2B&tags=a&tags=b");
    const text = definition([], {
      mediaType: "text/plain",
      schema: { type: "string" },
      required: true,
    });
    expect(
      new TextDecoder().decode(
        serializeHttpArguments(text, { body: "text" }).body,
      ),
    ).toBe("text");
    expect(() => serializeHttpArguments(text, { body: 1 })).toThrow();
    expect(() => serializeHttpArguments(text, {})).toThrow();
  });
  it("supports nonnull scalar type unions and simple exploded path objects", () => {
    const tool = normalizeHttpTool(
      definition([
        parameter(
          "id",
          "path",
          {
            type: "object",
            properties: {
              a: { type: ["integer", "string"] },
              b: { type: "string" },
            },
            additionalProperties: false,
          },
          true,
        ),
        parameter("q", "query", { type: ["integer", "string"] }),
      ]),
    ).tool;
    expect(
      serializeHttpArguments(tool, {
        path: { id: { a: 0, b: ".." } },
        query: { q: 0 },
      }).url,
    ).toBe(`${origin}/records/a=0,b=..?q=0`);
    expect(() =>
      normalizeHttpTool(
        definition([parameter("q", "query", { type: ["string", "null"] })]),
      ),
    ).toThrow();
  });
});

const org = "00000000-0000-4000-8000-000000000001",
  profile = "00000000-0000-4000-8000-000000000002",
  grant = "00000000-0000-4000-8000-000000000003",
  run = "00000000-0000-4000-8000-000000000004",
  owner = "00000000-0000-4000-8000-000000000005";
let db: SQLiteBinding;
let context: ArtifactRunContext;
let revoked = false;
function artifactService() {
  return createArtifactsService({
    database: { $client: db },
    secret: "public-http-artifact-unit-secret",
    authority: {
      async checkAccess(principal, scope) {
        if (principal.orgId !== scope.orgId || revoked)
          throw new Error("Authority denied");
        const row = await db
          .prepare(
            "SELECT enabled FROM control_profiles WHERE id=? AND org_id=?",
          )
          .bind(scope.profileId, scope.orgId)
          .first<{ enabled: number }>();
        if (!row?.enabled) throw new Error("Authority denied");
      },
      async checkRun(current) {
        const row = await db
          .prepare(
            "SELECT status,lease_owner,deadline FROM control_runs WHERE id=? AND org_id=? AND grant_id=? AND profile_id=?",
          )
          .bind(
            current.runId,
            current.orgId,
            current.grantId,
            current.profileId,
          )
          .first<{ status: string; lease_owner: string; deadline: number }>();
        if (
          revoked ||
          row?.status !== "running" ||
          row.lease_owner !== current.claimId ||
          row.deadline !== current.deadline
        )
          throw new Error("Authority denied");
      },
    },
  });
}
beforeEach(async () => {
  db = new SQLiteBinding(":memory:");
  for (const name of [
    "0000_initial.sql",
    "0001_control.sql",
    "0002_m2_catalog.sql",
    "0003_m2_accounts.sql",
    "0004_m2_artifacts.sql",
  ])
    await db.exec(
      await readFile(
        new URL(`../../database/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO organizations (id,name,slug) VALUES (?,'HTTP Public Unit','http-public-unit')",
    )
    .bind(org)
    .run();
  await db
    .prepare(
      "INSERT INTO control_profiles (id,org_id,label,created_at,updated_at) VALUES (?,?,'HTTP',?,?)",
    )
    .bind(profile, org, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO control_grants (id,org_id,profile_id,label,token_hash,created_at) VALUES (?,?,?,'HTTP','public-token-hash',?)",
    )
    .bind(grant, org, profile, now)
    .run();
  context = {
    orgId: org,
    profileId: profile,
    grantId: grant,
    runId: run,
    claimId: "public-claim",
    deadline: now + 300000,
    executionDeadline: now + 300000,
    selectedAccounts: {},
  };
  await db
    .prepare(
      "INSERT INTO control_runs(id,org_id,grant_id,profile_id,tool,tool_revision,status,created_at,updated_at,deadline,policy_decision,display_json,admitted_epoch,lease_owner,lease_until) VALUES(?,?,?,?,'sample.records','public-v1','running',?,?,?,'allow','{}',0,?,?)",
    )
    .bind(
      run,
      org,
      grant,
      profile,
      now,
      now,
      context.deadline,
      context.claimId,
      context.executionDeadline,
    )
    .run();
  revoked = false;
});
afterEach(() => {
  db.close();
});
function realBroker(
  tool: ToolDefinition,
  response: () => Response,
  onRequest?: (input: HttpTransportInput) => void,
) {
  const accounts = createAccountsService({
    db: createDatabase(db),
    secret: "public-account-unit-secret",
    providers: [],
  });
  return createBroker({
    accounts,
    orgId: org,
    principalId: owner,
    requirements: tool.requirements,
    selections: {},
    permissions: tool.permissions,
    signal: AbortSignal.timeout(300000),
    requestHeaders:
      tool.implementation.kind === "http"
        ? tool.implementation.parameters
            .filter((p) => p.in === "header")
            .map((p) => p.name)
        : [],
    transport: {
      async request(input) {
        onRequest?.(input);
        return response();
      },
    },
    async beforeRequest() {
      if (revoked) throw new Error("Authority denied");
      const row = await db
        .prepare("SELECT status,lease_owner FROM control_runs WHERE id=?")
        .bind(run)
        .first<{ status: string; lease_owner: string }>();
      if (row?.status !== "running" || row.lease_owner !== context.claimId)
        throw new Error("Authority denied");
    },
  });
}
async function invoke(
  tool: ToolDefinition,
  response: () => Response,
  args: Record<string, JSONValue> = {},
  onRequest?: (input: HttpTransportInput) => void,
) {
  const service = artifactService();
  await service.freezeInputs(
    context,
    await validateHttpArtifactInputs({
      tool,
      arguments: args,
      artifacts: { service, context },
    }),
  );
  await service.verifyInputs(context);
  return invokeHttpTool({
    runId: run,
    claimId: context.claimId,
    deadlineMs: context.executionDeadline,
    tool: frozen(tool),
    arguments: args,
    broker: realBroker(tool, response, onRequest),
    artifacts: { service, context },
  });
}

describe("M2 actual HTTP adapter through trusted broker and encrypted SQLite artifacts", () => {
  it.each([
    ["text", "text/plain", "prefix public-http-disclosure-token suffix", false],
    [
      "nested JSON",
      "application/json",
      '{"nested":[{"value":"public-http-disclosure-token"}]}',
      false,
    ],
    [
      "escaped JSON",
      "application/json",
      '{"nested":{"value":"\\u0070ublic-http-disclosure-token"}}',
      false,
    ],
    [
      "sensitive key",
      "application/json",
      '{"\\u0070ublic-http-disclosure-token":"value"}',
      true,
    ],
    [
      "malformed JSON",
      "application/json",
      '{"value":"public-http-disclosure-token"',
      true,
    ],
    [
      "reviewed literal",
      "application/json",
      '{"value":"public-http-disclosure-token"}',
      true,
    ],
  ] as const)(
    "protects consumer-visible %s through the HTTP adapter, trusted broker and encrypted Account",
    async (scenario, mediaType, body, rejected) => {
      const token = "public-http-disclosure-token";
      const accounts = createAccountsService({
        db: createDatabase(db),
        secret: "public-account-unit-secret",
        providers: [
          createGithubProvider({
            transport: {
              async request() {
                return Response.json(
                  { id: 101, login: "public-http-fixture" },
                  { headers: { "x-oauth-scopes": "read:user" } },
                );
              },
            },
          }),
        ],
      });
      const account = await accounts.createAccount(
        { orgId: org, userId: owner },
        {
          provider: "github",
          alias: "Public disclosure fixture",
          ownership: "workspace",
          method: "bearer",
          identity: { subject: "101" },
          scopes: ["read:user"],
          credential: { kind: "bearer", token },
        },
      );
      const raw = definition();
      raw.requirements = {
        source: {
          provider: "github",
          methods: ["bearer"],
          scopes: ["read:user"],
          issuer: "https://github.com",
          audience: "https://api.github.com",
        },
      };
      raw.permissions = [
        {
          requirement: "source",
          origin: "https://api.github.com",
          methods: ["GET"],
          path: "/user",
          match: "exact",
        },
      ];
      if (raw.implementation.kind !== "http") throw new Error("HTTP required");
      raw.implementation.url = "https://api.github.com/user";
      const schema: JSONSchema =
        scenario === "reviewed literal"
          ? {
              type: "object",
              properties: { value: { const: token } },
              required: ["value"],
            }
          : { type: mediaType === "text/plain" ? "string" : "object" };
      raw.implementation.response = { mediaType, schema };
      if (mediaType === "application/json") raw.outputSchema = schema;
      const tool = normalizeHttpTool(raw).tool;
      const selections = await accounts.resolveBindings({
        orgId: org,
        principalId: owner,
        requirements: tool.requirements,
        bindings: { "sample.source": account.accountId },
        integrationSlug: "sample",
      });
      const broker = createBroker({
        accounts,
        orgId: org,
        principalId: owner,
        requirements: tool.requirements,
        selections,
        permissions: tool.permissions,
        signal: AbortSignal.timeout(300000),
        transport: {
          async request() {
            return new Response(body, {
              headers: { "content-type": mediaType },
            });
          },
        },
        async beforeRequest() {},
      });
      const invocation = invokeHttpTool({
        runId: run,
        claimId: context.claimId,
        deadlineMs: context.executionDeadline,
        tool: frozen(tool),
        arguments: {},
        broker,
      });
      if (rejected) {
        const error = await invocation.catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: "unsupported_result",
          effect: { state: "possible" },
        });
        expect(String(error)).not.toContain(token);
      } else {
        const output = await invocation;
        expect(output.effect).toEqual({ state: "completed" });
        expect(JSON.stringify(output.result)).not.toContain(token);
        expect(JSON.stringify(output.result)).toContain("[redacted]");
        if (mediaType === "application/json")
          expect(output.result.structuredContent).toEqual({
            nested:
              scenario === "nested JSON"
                ? [{ value: "[redacted]" }]
                : { value: "[redacted]" },
          });
        else
          expect(output.result.content).toEqual([
            { type: "text", text: "prefix [redacted] suffix" },
          ]);
      }
    },
  );
  it.each([
    ["dns_failure", false, true, "verified_no_effect"],
    ["connection_failure", false, true, "verified_no_effect"],
    ["timeout", false, true, "verified_no_effect"],
    ["unsafe_target", false, false, "verified_no_effect"],
    ["connection_failure", true, false, "possible"],
  ] as const)(
    "classifies %s dispatched=%s through the HTTP adapter without losing safe retry authority",
    async (code, dispatched, retryable, state) => {
      const tool = normalizeHttpTool(definition()).tool;
      expect(tool.operationClass).toBe("unknown");
      const error = await invoke(tool, () => {
        throw new TransportError(code, dispatched);
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code:
          code === "unsafe_target"
            ? "broker_forbidden"
            : "upstream_unavailable",
        effect: { state },
      });
      if (retryable) expect(error).toMatchObject({ retryable: true });
      else expect(error).not.toMatchObject({ retryable: true });
    },
  );
  it("returns native object MCP results and completed evidence with no extra envelope", async () => {
    const result = await invoke(
      normalizeHttpTool(definition()).tool,
      () =>
        new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(result.result.structuredContent).toEqual({ ok: true });
    expect(result.result.content).toEqual([
      { type: "text", text: '{"ok":true}' },
    ]);
    expect(result.effect.state).toBe("completed");
  });
  it("preserves uncertain effect when a write response is malformed, oversized or HTTP500", async () => {
    const tool = definition([], {
      mediaType: "application/json",
      schema: { type: "object" },
    });
    for (const response of [
      () =>
        new Response('{"ok":true,"ok":false}', {
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response("x".repeat(1048577), {
          headers: { "content-type": "application/json" },
        }),
      () => new Response("private provider body", { status: 500 }),
    ]) {
      await expect(invoke(tool, response, { body: {} })).rejects.toMatchObject({
        effect: { state: "possible" },
      });
    }
  });
  it("does not treat GET or an unknown operation class as independently verified no effect", async () => {
    await expect(
      invoke(definition(), () => new Response("failed", { status: 500 })),
    ).rejects.toMatchObject({ effect: { state: "possible" } });
  });
  it("validates exact status output schema and does not fall back to the top-level contract", async () => {
    const tool = definition();
    await expect(
      invoke(
        tool,
        () =>
          new Response('{"ok":true}', {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
    if (tool.implementation.kind !== "http") throw new Error();
    tool.implementation.response.statuses!.default = {
      mediaType: "application/json",
      schema: { type: "array", items: { type: "integer" } },
    };
    const result = await invoke(
      tool,
      () =>
        new Response("[0,1]", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(result.result.content[0]!.text).toBe("[0,1]");
    expect(result.result.structuredContent).toBeUndefined();
  });
  it("rejects media, UTF8, output schema and complete duplicated result budget violations", async () => {
    for (const response of [
      () =>
        new Response("plain", { headers: { "content-type": "text/plain" } }),
      () =>
        new Response(new Uint8Array([0xff]), {
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response('{"ok":"not-a-boolean"}', {
          headers: { "content-type": "application/json" },
        }),
    ])
      await expect(invoke(definition(), response)).rejects.toMatchObject({
        effect: { state: "possible" },
      });
    const tool = definition();
    if (tool.implementation.kind !== "http") throw new Error();
    tool.implementation.response.statuses!["200"]!.schema = { type: "object" };
    await expect(
      invoke(
        tool,
        () =>
          new Response(JSON.stringify({ value: "a".repeat(600000) }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    ).rejects.toMatchObject({
      code: "payload_too_large",
      effect: { state: "possible" },
    });
  });
  it("honors an explicitly false Tool output schema rather than skipping its validation", async () => {
    const tool = definition();
    tool.outputSchema = false;
    await expect(
      invoke(
        tool,
        () =>
          new Response('{"ok":true}', {
            headers: { "content-type": "application/json" },
          }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
    if (tool.implementation.kind !== "http") throw new Error();
    tool.implementation.response = { mediaType: "application/octet-stream" };
    await expect(
      invoke(
        tool,
        () =>
          new Response(new Uint8Array([1]), {
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
  });
  it("returns bodyless HEAD and204 without inventing JSON", async () => {
    const tool = definition();
    if (tool.implementation.kind !== "http") throw new Error();
    tool.implementation.method = "HEAD";
    tool.permissions[0]!.methods = ["HEAD"];
    expect(
      (await invoke(tool, () => new Response(null, { status: 200 }))).result
        .content,
    ).toEqual([]);
    tool.implementation.method = "GET";
    tool.permissions[0]!.methods = ["GET"];
    tool.implementation.response.statuses!["204"] = { mediaType: "text/plain" };
    expect(
      (await invoke(tool, () => new Response(null, { status: 204 }))).result
        .content,
    ).toEqual([]);
  });
  it("stores binary results behind authenticated artifact references, never base64 or public URLs", async () => {
    const tool = definition();
    if (tool.implementation.kind !== "http") throw new Error();
    tool.implementation.response = {
      mediaType: "application/octet-stream",
      statuses: { "200": { mediaType: "application/octet-stream" } },
    };
    const service = artifactService();
    await service.freezeInputs(context, []);
    const result = await invokeHttpTool({
      runId: run,
      claimId: context.claimId,
      deadlineMs: context.executionDeadline,
      tool: frozen(tool),
      arguments: {},
      broker: realBroker(
        tool,
        () =>
          new Response(new Uint8Array([0, 1, 255]), {
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
      artifacts: { service, context },
    });
    const artifact = result.result.structuredContent!.artifact as Record<
      string,
      JSONValue
    >;
    expect(artifact.size_bytes).toBe(3);
    expect(artifact).not.toHaveProperty("url");
    const downloaded = await service.download(
      { kind: "owner", orgId: org, userId: owner },
      artifact.artifact_id as string,
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 255]),
    );
  });
  it("executes bodyless HEAD with a nominal binary media contract without artifact storage", async () => {
    const tool = definition();
    if (tool.implementation.kind !== "http") throw new Error();
    tool.implementation.method = "HEAD";
    tool.implementation.response = { mediaType: "application/octet-stream" };
    tool.permissions[0]!.methods = ["HEAD"];
    const result = await invokeHttpTool({
      runId: run,
      claimId: context.claimId,
      deadlineMs: context.executionDeadline,
      tool: frozen(tool),
      arguments: {},
      broker: realBroker(tool, () => new Response(null)),
    });
    expect(result.result.content).toEqual([]);
    expect(result.effect.state).toBe("completed");
  });
  it("consumes only authorized ready artifact IDs in trusted multipart and rechecks revocation", async () => {
    const service = artifactService();
    const ref = await service.upload(
      { kind: "owner", orgId: org, userId: owner },
      {
        profileId: profile,
        grantId: grant,
        mediaType: "application/octet-stream",
        filename: "public-file.bin",
        body: new Response(new Uint8Array([0, 1, 255])).body,
      },
    );
    const fileSchema: JSONSchema = {
      type: "object",
      properties: { artifact_id: { type: "string", format: "uuid" } },
      required: ["artifact_id"],
      additionalProperties: false,
    };
    const tool = normalizeHttpTool(
      definition([], {
        mediaType: "multipart/form-data",
        required: true,
        schema: {
          type: "object",
          properties: {
            file: fileSchema,
            label: { type: "string" },
            files: { type: "array", items: fileSchema },
          },
          required: ["file"],
          additionalProperties: false,
        },
      }),
    ).tool;
    const args = {
      body: {
        file: { artifact_id: ref.artifact_id },
        label: "hello",
        files: [{ artifact_id: ref.artifact_id }],
      },
    };
    const values = await validateHttpArtifactInputs({
      tool,
      arguments: args,
      artifacts: { service, context },
    });
    expect(values).toHaveLength(2);
    await service.freezeInputs(context, values);
    await service.verifyInputs(context);
    let sent = false;
    const broker = realBroker(
      tool,
      () =>
        new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
      (input) => {
        const raw = new TextDecoder().decode(input.body);
        expect(raw).toContain('name="file"; filename="public-file.bin"');
        expect(raw).toContain('name="files"; filename="public-file.bin"');
        expect(raw).toContain("hello");
        expect(input.headers.get("content-type")).toMatch(
          /^multipart\/form-data; boundary=mcpone_/,
        );
        sent = true;
      },
    );
    await invokeHttpTool({
      runId: run,
      claimId: context.claimId,
      deadlineMs: context.executionDeadline,
      tool: frozen(tool),
      arguments: args,
      broker,
      artifacts: { service, context },
    });
    expect(sent).toBe(true);
    revoked = true;
    await expect(
      validateHttpArtifactInputs({
        tool,
        arguments: args,
        artifacts: { service, context },
      }),
    ).rejects.toThrow();
  });
  it("rejects eleven file parts without sending and forbids client-authoritative metadata", async () => {
    const service = artifactService();
    const fileSchema: JSONSchema = {
      type: "object",
      properties: { artifact_id: { type: "string", format: "uuid" } },
      required: ["artifact_id"],
      additionalProperties: false,
    };
    const tool = normalizeHttpTool(
      definition([], {
        mediaType: "multipart/form-data",
        required: true,
        schema: {
          type: "object",
          properties: { files: { type: "array", items: fileSchema } },
          additionalProperties: false,
        },
      }),
    ).tool;
    await expect(
      validateHttpArtifactInputs({
        tool,
        arguments: {
          body: {
            files: [
              {
                artifact_id: "00000000-0000-4000-8000-000000000099",
                size_bytes: 1,
              },
            ],
          },
        },
        artifacts: { service, context },
      }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    const ref = await service.upload(
      { kind: "owner", orgId: org, userId: owner },
      {
        profileId: profile,
        grantId: grant,
        mediaType: "application/octet-stream",
        body: new Response("x").body,
      },
    );
    await expect(
      validateHttpArtifactInputs({
        tool,
        arguments: {
          body: {
            files: Array.from({ length: 11 }, () => ({
              artifact_id: ref.artifact_id,
            })),
          },
        },
        artifacts: { service, context },
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });
});
