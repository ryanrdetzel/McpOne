import {
  AccountBindings,
  AccountIdentity,
  AccountView,
  ArtifactInput,
  ArtifactRef,
  BusinessMcpResult,
  CreateAccountInput,
  CreateIntegrationInput,
  EffectEvidence,
  Implementation,
  JsonSchema,
  jsonProblem,
  M2FingerprintPayload,
  Permission,
  ProfilePublication,
  ProfileView,
  Requirement,
  ReviewDiagnostic,
  ReviewReport,
  Source,
  ToolDefinition,
} from "@scaffold/schema/integrations";
import { describe, expect, it } from "vitest";
import { validateInput, validateSchema } from "../src/integrations/schema";

const id = "00000000-0000-4000-8000-000000000001";
const objectSchema = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
};
const tool = {
  name: "public.count",
  description: "Public contract fixture",
  inputSchema: objectSchema,
  operationClass: "read",
  requirements: {},
  permissions: [],
  implementation: {
    kind: "typescript",
    source: "export default (input) => input;",
    entrypoint: "default",
    modules: {},
  },
};

describe("M2 strict shared contracts", () => {
  it("preserves schemas without constraining permissive upstream properties", () => {
    const parsed = ToolDefinition.parse(tool);
    expect(parsed.inputSchema).toEqual(objectSchema);
    if (typeof parsed.inputSchema === "boolean")
      throw new Error("Expected the parsed object schema fixture");
    expect(Object.hasOwn(parsed.inputSchema, "additionalProperties")).toBe(
      false,
    );
    expect(
      validateInput(parsed.inputSchema, { count: 0, extra: true }).valid,
    ).toBe(true);
    expect(ToolDefinition.safeParse({ ...tool, extra: true }).success).toBe(
      false,
    );
    expect(Source.safeParse({ kind: "http", tools: [tool] }).success).toBe(
      false,
    );
    expect(
      CreateIntegrationInput.safeParse({
        slug: "different",
        displayName: "Public fixture",
        source: { kind: "typescript", tools: [tool] },
      }).success,
    ).toBe(false);
  });
  it("proves object-only references/compositions without adding types or dropping constraints", () => {
    const schema = {
      $defs: { input: objectSchema },
      $ref: "#/$defs/input",
      maxProperties: 2,
    };
    expect(
      ToolDefinition.parse({ ...tool, inputSchema: schema }).inputSchema,
    ).toEqual(schema);
    expect(
      ToolDefinition.safeParse({
        ...tool,
        inputSchema: { anyOf: [false, { type: "object" }] },
      }).success,
    ).toBe(true);
    expect(
      ToolDefinition.safeParse({
        ...tool,
        inputSchema: { allOf: [{ type: "object" }, { maxProperties: 2 }] },
      }).success,
    ).toBe(true);
    expect(
      ToolDefinition.safeParse({
        ...tool,
        inputSchema: { anyOf: [{ type: "object" }, { type: "string" }] },
      }).success,
    ).toBe(false);
    expect(
      ToolDefinition.safeParse({ ...tool, inputSchema: true }).success,
    ).toBe(false);
  });
  it("structurally bounds schemas but leaves semantic diagnostics to core", () => {
    expect(
      JsonSchema.safeParse({ type: "string", patternProperties: {} }).success,
    ).toBe(true);
    const result = validateSchema({
      type: "object",
      properties: { field: { unknownConstraint: true } },
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "unsupported_schema",
      schemaPath: "/properties/field/unknownConstraint",
      keyword: "unknownConstraint",
    });
    expect(
      JsonSchema.safeParse({
        properties: Object.fromEntries(
          Array.from({ length: 257 }, (_, n) => [String(n), {}]),
        ),
      }).success,
    ).toBe(false);
  });
  it("keeps own prototype-like JSON properties as data", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"object"},"constructor":{"type":"string"}},"additionalProperties":false}',
    );
    const value = JSON.parse(
      '{"__proto__":{"safe":true},"constructor":"data"}',
    );
    expect(validateInput(schema, value).valid).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).safe).toBeUndefined();
  });
  it("preserves review-selected HTTP dialect, body presence and explicit/default status schemas", () => {
    const implementation = {
      kind: "http",
      dialect: "3.0",
      method: "POST",
      url: "https://example.com/public",
      parameters: [],
      requestBody: {
        mediaType: "application/json",
        schema: { type: "string", nullable: true },
        required: true,
      },
      response: {
        mediaType: "application/json",
        statuses: {
          "201": { mediaType: "application/json", schema: { type: "object" } },
          default: { mediaType: "text/plain", schema: { type: "string" } },
        },
      },
    };
    expect(Implementation.parse(implementation)).toEqual(implementation);
    expect(
      Implementation.safeParse({ ...implementation, dialect: "2.0" }).success,
    ).toBe(false);
    expect(
      Implementation.safeParse({
        ...implementation,
        response: {
          mediaType: "application/json",
          statuses: { "2XX": { mediaType: "application/json" } },
        },
      }).success,
    ).toBe(false);
    expect(
      Implementation.safeParse({
        ...implementation,
        response: { mediaType: "application/json", statuses: {} },
      }).success,
    ).toBe(false);
  });
  it("rejects credential/identity authority on public views and manual OAuth creation", () => {
    expect(
      AccountIdentity.safeParse({ subject: "public", ownerUserId: id }).success,
    ).toBe(false);
    const account = {
      accountId: id,
      provider: "public",
      alias: "Public fixture",
      ownership: "workspace",
      ownerUserId: null,
      method: "none",
      identity: { subject: "public" },
      scopes: [],
      enabled: true,
      health: "unverified",
      expiresAt: null,
      createdAt: "2026-10-08T00:00:00.000Z",
    };
    expect(AccountView.safeParse(account).success).toBe(true);
    expect(
      AccountView.safeParse({
        ...account,
        credential: { kind: "bearer", token: "public-fixture-only" },
      }).success,
    ).toBe(false);
    expect(AccountView.safeParse({ ...account, ownerUserId: id }).success).toBe(
      false,
    );
    const input = {
      provider: "public",
      alias: "Public fixture",
      ownership: "workspace",
      method: "none",
      identity: { subject: "public" },
      scopes: [],
    };
    expect(CreateAccountInput.safeParse(input).success).toBe(true);
    expect(
      CreateAccountInput.safeParse({ ...input, method: "oauth2" }).success,
    ).toBe(false);
  });
  it("bounds safe artifacts and does not trust supplied input metadata", () => {
    const artifact = {
      artifact_id: id,
      media_type: "application/octet-stream",
      size_bytes: 26214400,
      sha256: "a".repeat(64),
      filename: "public.bin",
      expires_at: "2026-10-15T00:00:00.000Z",
    };
    expect(ArtifactRef.safeParse(artifact).success).toBe(true);
    expect(
      ArtifactRef.safeParse({ ...artifact, size_bytes: 26214401 }).success,
    ).toBe(false);
    expect(
      ArtifactRef.safeParse({ ...artifact, filename: "../public.bin" }).success,
    ).toBe(false);
    expect(ArtifactInput.safeParse({ artifact_id: id }).success).toBe(true);
    expect(ArtifactInput.safeParse(artifact).success).toBe(false);
  });
  it("preserves business content while rejecting unknown blocks and reserved metadata", () => {
    const result = {
      content: [{ type: "text", text: "public fixture" }],
      structuredContent: { ok: true },
      isError: true,
      _meta: { thirdParty: { safe: true } },
    };
    expect(BusinessMcpResult.parse(result)).toEqual(result);
    expect(
      BusinessMcpResult.safeParse({ content: [{ type: "image", data: "" }] })
        .success,
    ).toBe(false);
    expect(
      BusinessMcpResult.safeParse({
        ...result,
        _meta: { "com.toolcontrolplane/execution": {} },
      }).success,
    ).toBe(false);
    expect(
      EffectEvidence.safeParse({
        state: "not_dispatched",
        arbitraryProof: true,
      }).success,
    ).toBe(false);
  });
  it("rejects noncanonical permissions and authority expansion in fingerprints", () => {
    const permission = {
      requirement: null,
      origin: "https://example.com",
      methods: ["GET"],
      path: "/public",
      match: "prefix",
    };
    expect(Permission.safeParse(permission).success).toBe(true);
    for (const origin of [
      "https://example.com/",
      "https://example.com:444",
      "https://user@example.com",
    ])
      expect(Permission.safeParse({ ...permission, origin }).success).toBe(
        false,
      );
    for (const path of [
      "/public/../admin",
      "/public%2fadmin",
      "/public%00",
      "/public?other=1",
    ])
      expect(Permission.safeParse({ ...permission, path }).success).toBe(false);
    const frame = {
      version: "m2",
      organization_id: "org-example",
      grant_id: "grant-example",
      profile_id: "profile-example",
      tool: "public.count",
      tool_revision: "tool-v1",
      integration_revision: "integration-v1",
      accounts: {},
      options: {},
      arguments: {},
    };
    expect(M2FingerprintPayload.safeParse(frame).success).toBe(true);
    expect(
      M2FingerprintPayload.safeParse({
        ...frame,
        accounts: {
          public: {
            account_id: id,
            identity_digest: "a".repeat(64),
            alias: "Mutable",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      M2FingerprintPayload.safeParse({
        ...frame,
        options: { unreviewed: true },
      }).success,
    ).toBe(false);
  });
  it("applies per-Integration limits without silently capping whole-Profile configurations", () => {
    const tools = Array.from(
      { length: 501 },
      (_, index) => `public.tool_${index}`,
    );
    const bindings = Object.fromEntries(
      Array.from({ length: 4001 }, (_, index) => [
        `integration_${index}.public`,
        id,
      ]),
    );
    expect(
      ProfileView.safeParse({
        profileId: id,
        label: "Public fixture",
        revision: 0,
        enabled: true,
        tools,
        bindings,
      }).success,
    ).toBe(true);
    expect(AccountBindings.safeParse(bindings).success).toBe(true);
    expect(
      ProfilePublication.safeParse({
        profileId: id,
        expectedRevision: 0,
        tools,
        bindings: {},
        policies: [],
      }).success,
    ).toBe(true);
    expect(
      Requirement.safeParse({
        provider: "public",
        methods: ["none"],
        scopes: Array.from({ length: 257 }, (_, index) => `scope-${index}`),
      }).success,
    ).toBe(true);
    const permission = {
      requirement: null,
      origin: "https://example.com",
      methods: ["GET"],
      path: "/public",
      match: "exact",
    };
    expect(
      ToolDefinition.safeParse({
        ...tool,
        permissions: Array(257).fill(permission),
      }).success,
    ).toBe(true);
  });
  it("counts the source entry in the 32-module closure and rejects canonical path collisions", () => {
    const implementation = tool.implementation;
    const modules = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [
        `m${index}.ts`,
        "export const publicValue = 1;",
      ]),
    );
    expect(
      Implementation.safeParse({ ...implementation, modules }).success,
    ).toBe(true);
    expect(
      Implementation.safeParse({
        ...implementation,
        modules: { ...modules, extra: "" },
      }).success,
    ).toBe(false);
    expect(
      Implementation.safeParse({
        ...implementation,
        modules: { ...modules, "extra.ts": "" },
      }).success,
    ).toBe(false);
    for (const modules of [
      { "entry.ts": "" },
      { "./entry.ts": "" },
      { "a.ts": "", "./a.ts": "" },
    ])
      expect(
        Implementation.safeParse({ ...implementation, modules }).success,
      ).toBe(false);
  });
  it("carries bounded review diagnostics without insertion, truncation, or arbitrary count caps", () => {
    const diagnostic = {
      upstreamName: "public",
      path: "/paths/~1public/get/responses/200/content",
      code: "excluded_media",
      message: "Owner selection excludes this supported alternative.",
    };
    const report = {
      integrationId: id,
      draftRevisionId: id,
      reportDigest: "a".repeat(64),
      accepted: [],
      rejected: [],
      changes: [],
      affectedProfiles: [],
    };
    expect(Object.hasOwn(ReviewReport.parse(report), "diagnostics")).toBe(
      false,
    );
    expect(
      ReviewReport.safeParse({
        ...report,
        diagnostics: Array(501).fill(diagnostic),
      }).success,
    ).toBe(true);
    expect(
      ReviewDiagnostic.safeParse({ ...diagnostic, message: "😀".repeat(512) })
        .success,
    ).toBe(true);
    expect(
      ReviewDiagnostic.safeParse({ ...diagnostic, message: "😀".repeat(513) })
        .success,
    ).toBe(false);
    expect(
      ReviewDiagnostic.safeParse({ ...diagnostic, path: "/invalid~escape" })
        .success,
    ).toBe(false);
    expect(
      ReviewDiagnostic.safeParse({ ...diagnostic, extra: true }).success,
    ).toBe(false);
  });
});

describe("M2 bounded interpretation invariants", () => {
  it("does not coerce, insert defaults, strip unknown input, or mutate the schema", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer", default: 1 } },
      required: ["count"],
      additionalProperties: false,
    };
    const before = JSON.stringify(schema),
      input = { count: "1", extra: "public" };
    expect(validateInput(schema, input).valid).toBe(false);
    expect(validateInput(schema, {}).valid).toBe(false);
    expect(input).toEqual({ count: "1", extra: "public" });
    expect(JSON.stringify(schema)).toBe(before);
  });
  it("evaluates safe literal/class/repetition patterns with unanchored search semantics", () => {
    for (const [pattern, value, accepted] of [
      ["a?b", "xxbzz", true],
      ["^a*b+$", "aaabb", true],
      ["^a+b+$", "b", false],
      ["^[^a-c]{2}$", "😀z", true],
      ["^a\\.b$", "a.b", true],
      ["^a\\.b$", "axb", false],
      ["^.$", "\n", false],
      ["a{2,4}", "xaaay", true],
      ["^$", "", true],
    ] as const)
      expect(
        validateInput({ type: "string", pattern }, value).valid,
        pattern,
      ).toBe(accepted);
  });
  it("fails closed on bounded NFA work exhaustion rather than reporting a match", () => {
    const schema = { type: "string", pattern: "a{0,1024}b" };
    expect(validateSchema(schema).valid).toBe(true);
    const result = validateInput(schema, "a".repeat(20000));
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "schema_limit",
      keyword: "budget",
    });
  });
  it("uses exact decimal divisibility at very small and large exponent scales", () => {
    expect(validateInput({ multipleOf: 1e-300 }, 3e-300).valid).toBe(true);
    expect(
      validateInput({ multipleOf: 1e-300 }, 3.000000000000001e-300).valid,
    ).toBe(false);
    expect(validateInput({ multipleOf: 1e100 }, 3e100).valid).toBe(true);
    expect(validateInput({ multipleOf: 0.1 }, -0.3).valid).toBe(true);
    expect(validateInput({ multipleOf: 0.1 }, 0.30000000000000004).valid).toBe(
      false,
    );
  });
  it("accepts unambiguous RFC4291 IPv6 spellings, not only RFC5952 presentation", () => {
    for (const value of [
      "2001:0DB8:0:0:0:0:0:1",
      "::1",
      "::",
      "::ffff:192.0.2.1",
    ])
      expect(validateInput({ format: "ipv6" }, value).valid).toBe(true);
    for (const value of [
      "[::1]",
      "fe80::1%eth0",
      "2001::db8::1",
      "::ffff:192.000.2.1",
    ])
      expect(validateInput({ format: "ipv6" }, value).valid).toBe(false);
  });
  it("counts boolean-schema nodes and deduplicates local reference targets", () => {
    const definitions = Object.fromEntries(
      Array.from({ length: 9999 }, (_, n) => [`n${n}`, true]),
    );
    const schema = { $defs: definitions, $ref: "#/$defs/n0" };
    expect(validateSchema(schema).valid).toBe(true);
    expect(JsonSchema.safeParse(schema).success).toBe(true);
    const oversized = { $defs: { ...definitions, extra: false } };
    expect(validateSchema(oversized).valid).toBe(false);
    expect(JsonSchema.safeParse(oversized).success).toBe(false);
  });
  it("supports 32 property-schema edges even when JSON container depth is greater", () => {
    let schema: Record<string, unknown> = { type: "string" },
      input: unknown = "public";
    for (let depth = 0; depth < 32; depth++) {
      schema = {
        type: "object",
        properties: { inner: schema },
        required: ["inner"],
      };
      input = { inner: input };
    }
    expect(validateSchema(schema).valid).toBe(true);
    expect(JsonSchema.safeParse(schema).success).toBe(true);
    expect(validateInput(schema, input).valid).toBe(true);
    expect(
      validateSchema({ type: "object", properties: { inner: schema } }).valid,
    ).toBe(false);
  });
  it("collects directional annotations from matching alternatives before rejecting property presence", () => {
    const mixed = {
      type: "object",
      properties: {
        x: { anyOf: [{ type: "integer", readOnly: true }, { type: "string" }] },
      },
      required: ["x"],
    };
    expect(validateInput(mixed, {}).valid).toBe(false);
    expect(validateInput(mixed, { x: "public" }).valid).toBe(true);
    expect(validateInput(mixed, { x: 1 }).valid).toBe(false);
    const overlap = {
      type: "object",
      properties: {
        x: { anyOf: [{ type: "integer", readOnly: true }, { type: "number" }] },
      },
      required: ["x"],
    };
    expect(validateInput(overlap, { x: 1 }).valid).toBe(false);
    expect(validateInput(overlap, { x: 1.5 }).valid).toBe(true);
    const sole = {
      type: "object",
      properties: {
        x: { oneOf: [{ type: "integer", readOnly: true }, { type: "string" }] },
      },
      required: ["x"],
    };
    expect(validateInput(sole, { x: "public" }).valid).toBe(true);
    expect(validateInput(sole, { x: 1 }).valid).toBe(false);
    const conjunctive = {
      type: "object",
      properties: { x: { allOf: [{ readOnly: true }, { type: "integer" }] } },
      required: ["x"],
    };
    expect(validateInput(conjunctive, {}).valid).toBe(true);
    expect(validateInput(conjunctive, { x: 1 }).valid).toBe(false);
    const output = {
      type: "object",
      properties: {
        x: {
          anyOf: [{ type: "integer", writeOnly: true }, { type: "string" }],
        },
      },
      required: ["x"],
    };
    expect(
      validateInput(output, { x: "public" }, { direction: "response" }).valid,
    ).toBe(true);
    expect(
      validateInput(output, { x: 1 }, { direction: "response" }).valid,
    ).toBe(false);
  });
  it("rejects proven contradictory directions at import and conditional overlap at instance validation", () => {
    expect(
      validateSchema({ allOf: [{ readOnly: true }, { writeOnly: true }] })
        .valid,
    ).toBe(false);
    const schema = {
      type: "object",
      properties: {
        x: {
          anyOf: [
            { type: "integer", readOnly: true },
            { type: "number", writeOnly: true },
          ],
        },
      },
    };
    expect(validateSchema(schema).valid).toBe(true);
    expect(validateInput(schema, { x: 1 }).valid).toBe(false);
  });
  it("asserts RFC3986 URI grammar rather than permissive URL-parser repairs", () => {
    for (const value of [
      "urn:public:fixture",
      "https://[2001:DB8::1]/public",
      "https://example.com/a%5Bb%5D?x=1#public",
      "https://example.com/public#",
    ])
      expect(validateInput({ format: "uri" }, value).valid).toBe(true);
    for (const value of [
      "https://example.com/a[b]",
      "https://example.com/%zz",
      "https://example.com/#public#other",
    ])
      expect(validateInput({ format: "uri" }, value).valid).toBe(false);
  });
  it("preflights getters, host values, holes, Unicode and exact serialized-byte bounds", () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "field", {
      enumerable: true,
      get() {
        reads++;
        return "public";
      },
    });
    expect(validateInput(true, hostile).valid).toBe(false);
    expect(reads).toBe(0);
    for (const value of [Infinity, NaN, new Date(), Array(1), "\udfff"])
      expect(validateInput(true, value).valid).toBe(false);
    const hidden = Object.defineProperty({}, "field", {
      value: 1,
      enumerable: false,
    });
    expect(
      validateInput(
        {
          type: "object",
          properties: { field: { type: "integer" } },
          required: ["field"],
        },
        hidden,
      ).valid,
    ).toBe(false);
    expect(jsonProblem({ a: true }, 10)).toBeUndefined();
    expect(jsonProblem({ a: true }, 9)).toBeDefined();
    expect(jsonProblem("é", 4)).toBeUndefined();
    expect(jsonProblem("é", 3)).toBeDefined();
  });
  it("keeps errors value-free and caps diagnostic accumulation without skipping validation", () => {
    const result = validateInput(
      { type: "array", items: { type: "integer" } },
      Array(1000).fill("sensitive-business-value"),
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(64);
    expect(JSON.stringify(result)).not.toContain("sensitive-business-value");
  });
});
