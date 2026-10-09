import { z } from "zod";
import { EXECUTION_META_NAMESPACE, PolicyPattern } from "./execution.js";

export const M2_CONTRACT_VERSION = "0.2.2-m2" as const;
export const TYPESCRIPT_ENTRY_MODULE = "entry.ts" as const;
export const M2_LIMITS = Object.freeze({
  jsonBytes: 1048576,
  documentBytes: 5242880,
  derivedMetadataBytes: 8388608,
  schemaDepth: 32,
  schemaNodes: 10000,
  properties: 256,
  enumEntries: 256,
  compositionBranches: 8,
  compositionDepth: 4,
  validationVisits: 100000,
  patternStates: 65536,
  validationWork: 10000000,
  referenceDepth: 10,
  references: 1000,
  requirements: 8,
  tools: 500,
  artifactBytes: 26214400,
  sourceBytes: 262144,
  moduleBytes: 1048576,
  modules: 32,
});
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };
export type JSONSchema = boolean | { [key: string]: JSONValue };
/** Inclusive UTF-16 membership, preserving exact wire-validation character sets. */
export function hasCodeUnitInRange(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= minimum && code <= maximum) return true;
  }
  return false;
}
const own = (value: object, key: string) => Object.hasOwn(value, key);
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function validString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
/** Bounded preflight before recursive parsers/canonicalizers; no getters or host objects. */
export function jsonProblem(
  value: unknown,
  maxBytes: number = M2_LIMITS.jsonBytes,
  maxDepth = 64,
): string | undefined {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128)
    return "Invalid JSON depth bound";
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  function visit(v: unknown, depth: number): boolean {
    if (++nodes > 100000 || depth > maxDepth) return false;
    if (v === null || typeof v === "boolean") bytes += v === false ? 5 : 4;
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) return false;
      bytes += JSON.stringify(v).length;
    } else if (typeof v === "string") {
      if (!validString(v) || v.length > maxBytes) return false;
      bytes += encoder.encode(JSON.stringify(v)).length;
    } else if (typeof v === "object") {
      if ((!Array.isArray(v) && !isJsonObject(v)) || ancestors.has(v))
        return false;
      if (Object.getOwnPropertySymbols(v).length) return false;
      ancestors.add(v);
      bytes += 2;
      const keys = Object.keys(v);
      if (
        Object.getOwnPropertyNames(v).length !==
        keys.length + (Array.isArray(v) ? 1 : 0)
      )
        return false;
      if (
        Array.isArray(v) &&
        (keys.length !== v.length ||
          keys.some((key, index) => key !== String(index)))
      )
        return false;
      for (const [index, key] of keys.entries()) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor || !("value" in descriptor) || !validString(key))
          return false;
        if (!Array.isArray(v))
          bytes += encoder.encode(JSON.stringify(key)).length + 1;
        if (index > 0) bytes++;
        if (bytes > maxBytes || !visit(descriptor.value, depth + 1))
          return false;
      }
      ancestors.delete(v);
    } else return false;
    return bytes <= maxBytes;
  }
  return visit(value, 0)
    ? undefined
    : "JSON must be finite, acyclic, valid Unicode and within structural/byte limits";
}
export const JsonValue = z
  .custom<JSONValue>((v) => !jsonProblem(v))
  .meta({
    type: ["null", "boolean", "number", "string", "array", "object"],
    description:
      "Finite JSON data within the reviewed byte and structural bounds.",
  });
export const JsonObject = z
  .custom<Record<string, JSONValue>>((v) => isJsonObject(v) && !jsonProblem(v))
  .meta({ type: "object", additionalProperties: true });
/** Structural budgets do not rewrite or strip upstream validation keywords. */
export function schemaStructureProblem(
  value: unknown,
  nodes = new Set<object>(),
): string | undefined {
  // Property/composition containers add JSON edges beyond the 32 schema-edge budget.
  if (jsonProblem(value, M2_LIMITS.documentBytes, 128))
    return "Schema must be bounded JSON";
  function visit(
    schema: unknown,
    depth: number,
    compositionDepth: number,
    countBooleanNodes = true,
  ): boolean {
    if (depth > 32) return false;
    if (typeof schema === "boolean") {
      // Boolean schema occurrences are nodes too; markers live only in this bounded review ledger.
      if (countBooleanNodes) nodes.add(Object.create(null) as object);
      return nodes.size <= M2_LIMITS.schemaNodes;
    }
    if (!isJsonObject(schema)) return false;
    const first = !nodes.has(schema);
    nodes.add(schema);
    if (nodes.size > M2_LIMITS.schemaNodes) return false;
    for (const key of ["properties", "$defs"])
      if (own(schema, key)) {
        const entries = schema[key];
        if (
          !isJsonObject(entries) ||
          (key === "properties" && Object.keys(entries).length > 256)
        )
          return false;
        for (const child of Object.values(entries))
          if (
            !visit(
              child,
              depth + 1,
              compositionDepth,
              countBooleanNodes && first,
            )
          )
            return false;
      }
    for (const key of ["items", "additionalProperties"])
      if (
        own(schema, key) &&
        !visit(
          schema[key],
          depth + 1,
          compositionDepth,
          countBooleanNodes && first,
        )
      )
        return false;
    for (const key of ["allOf", "oneOf", "anyOf"])
      if (own(schema, key)) {
        const branches = schema[key];
        if (
          !Array.isArray(branches) ||
          !branches.length ||
          branches.length > 8 ||
          compositionDepth >= 4
        )
          return false;
        for (const branch of branches)
          if (
            !visit(
              branch,
              depth + 1,
              compositionDepth + 1,
              countBooleanNodes && first,
            )
          )
            return false;
      }
    if (
      own(schema, "enum") &&
      (!Array.isArray(schema.enum) ||
        !schema.enum.length ||
        schema.enum.length > 256)
    )
      return false;
    return true;
  }
  return visit(value, 0, 0)
    ? undefined
    : "Schema structure exceeds its bounds or has an invalid schema child";
}
export const JsonSchema = z
  .custom<JSONSchema>((v) => !schemaStructureProblem(v))
  .meta({
    type: ["boolean", "object"],
    description:
      "A bounded JSON Schema document; supported semantics are validated independently.",
  });
const bytes = (limit: number) =>
  z
    .string()
    .refine(
      (s) => validString(s) && new TextEncoder().encode(s).length <= limit,
      "UTF-8 byte limit exceeded",
    );
const text = (max: number, min = 0) =>
  z
    .string()
    .refine(
      (s) =>
        validString(s) &&
        Array.from(s).length >= min &&
        Array.from(s).length <= max,
      "Invalid Unicode scalar length",
    );
const nonempty = text(4096, 1);
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime({ offset: false });
const unique = <T extends z.ZodType>(s: T, max?: number, min = 0) => {
  const entries = z.array(s).min(min);
  return (max === undefined ? entries : entries.max(max)).refine(
    (a) => new Set(a).size === a.length,
    "Entries must be unique",
  );
};
/** Validate records without assigning attacker-controlled keys to an ordinary object. */
function record<T extends z.ZodType>(
  key: z.ZodType<string>,
  value: T,
  max?: number,
) {
  return z
    .custom<Record<string, z.infer<T>>>((v) => {
      if (
        !isJsonObject(v) ||
        (max !== undefined && Object.keys(v).length > max)
      )
        return false;
      return Object.keys(v).every((k) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, k);
        return (
          key.safeParse(k).success &&
          descriptor !== undefined &&
          "value" in descriptor &&
          value.safeParse(descriptor.value).success
        );
      });
    })
    .meta({
      type: "object",
      propertyNames: z.toJSONSchema(key, { unrepresentable: "any" }),
      additionalProperties: z.toJSONSchema(value, { unrepresentable: "any" }),
      ...(max === undefined ? {} : { maxProperties: max }),
    });
}
export const IntegrationSlug = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine((s) => s !== "runs", "Reserved namespace");
export const RequirementName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const IntegrationToolName = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)
  .refine((s) => !s.startsWith("runs."), "Reserved namespace");
export const OperationClass = z.enum([
  "read",
  "write",
  "destructive",
  "unknown",
]);
export type OperationClass = z.infer<typeof OperationClass>;
export const AuthMethod = z.enum([
  "none",
  "bearer",
  "api_key",
  "basic",
  "oauth2",
]);
export type AuthMethod = z.infer<typeof AuthMethod>;
export const HttpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
]);
export type HttpMethod = z.infer<typeof HttpMethod>;
export const Requirement = z
  .object({
    provider: RequirementName,
    methods: unique(AuthMethod, 5, 1),
    scopes: unique(nonempty),
    issuer: nonempty.optional(),
    audience: nonempty.optional(),
    tenant: nonempty.optional(),
    application: nonempty.optional(),
  })
  .strict();
export type Requirement = z.infer<typeof Requirement>;
const httpsUrl = nonempty.refine((s) => {
  try {
    const u = new URL(s);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      !hasCodeUnitInRange(s, 0, 32) &&
      !s.includes("\\")
    );
  } catch {
    return false;
  }
}, "Canonical HTTPS URL required");
export const PermissionOrigin = httpsUrl.refine(
  (s) => new URL(s).origin === s,
  "Exact canonical HTTPS origin required",
);
export const PermissionPath = nonempty.refine(
  (s) =>
    s.startsWith("/") &&
    !/[?#\\]/.test(s) &&
    !hasCodeUnitInRange(s, 0, 32) &&
    !/%(?:2f|5c|00)/i.test(s) &&
    !/%(?![\da-f]{2})/i.test(s) &&
    !s.split("/").some((p) => {
      try {
        const d = decodeURIComponent(p);
        return d === "." || d === "..";
      } catch {
        return true;
      }
    }) &&
    new URL(s, "https://example.com").pathname === s,
  "Canonical absolute pathname required",
);
export const Permission = z
  .object({
    requirement: RequirementName.nullable(),
    origin: PermissionOrigin,
    methods: unique(HttpMethod, 6, 1),
    path: PermissionPath,
    match: z.enum(["exact", "prefix"]),
  })
  .strict();
export type Permission = z.infer<typeof Permission>;
export const HttpParameter = z
  .object({
    name: nonempty,
    in: z.enum(["path", "query", "header"]),
    required: z.boolean(),
    schema: JsonSchema,
    style: z.enum(["simple", "form"]),
    explode: z.boolean(),
  })
  .strict()
  .refine(
    (v) => (v.in === "query" ? v.style === "form" : v.style === "simple"),
    "Unsupported location style",
  )
  .refine(
    (v) => v.in !== "path" || v.required,
    "Path parameters must be required",
  );
export type HttpParameter = z.infer<typeof HttpParameter>;
const modulePath = z
  .string()
  .max(256)
  .refine(
    (s) =>
      /^(?:\.\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.ts$/.test(s) &&
      !s.split("/").includes(".."),
    "Safe relative .ts module required",
  );
export const HttpResponseContract = z
  .object({ mediaType: nonempty, schema: JsonSchema.optional() })
  .strict();
export type HttpResponseContract = z.infer<typeof HttpResponseContract>;
export const Implementation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("typescript"),
      source: bytes(M2_LIMITS.sourceBytes),
      entrypoint: z.string().regex(/^(?:default|[a-zA-Z_$][a-zA-Z0-9_$]*)$/),
      modules: record(
        modulePath,
        bytes(M2_LIMITS.moduleBytes),
        M2_LIMITS.modules - 1,
      ),
    })
    .strict()
    .refine((v) => {
      const names = Object.keys(v.modules).map((name) =>
        name.startsWith("./") ? name.slice(2) : name,
      );
      return (
        !names.includes(TYPESCRIPT_ENTRY_MODULE) &&
        new Set(names).size === names.length
      );
    }, "Module closure duplicates its entry or a canonical module path")
    .refine((v) => {
      const encoder = new TextEncoder();
      let size = encoder.encode(v.source).length;
      for (const module of Object.values(v.modules)) {
        size += encoder.encode(module).length;
        if (size > M2_LIMITS.moduleBytes) return false;
      }
      return size <= M2_LIMITS.moduleBytes;
    }, "Source closure byte limit exceeded"),
  z
    .object({
      kind: z.literal("http"),
      dialect: z.enum(["3.0", "3.1"]).optional(),
      method: HttpMethod,
      url: httpsUrl,
      parameters: z.array(HttpParameter),
      requestBody: z
        .object({
          mediaType: nonempty,
          schema: JsonSchema,
          required: z.boolean().optional(),
        })
        .strict()
        .optional(),
      response: HttpResponseContract.extend({
        statuses: record(
          z.string().regex(/^(?:[1-5][0-9]{2}|default)$/),
          HttpResponseContract,
          501,
        )
          .refine(
            (v) => Object.keys(v).length > 0,
            "At least one status contract is required",
          )
          .optional(),
      }).strict(),
    })
    .strict()
    .refine(
      (v) => !v.requestBody || (v.method !== "GET" && v.method !== "HEAD"),
      "GET/HEAD bodies are unsupported",
    ),
  z
    .object({
      kind: z.literal("remote_mcp"),
      endpoint: httpsUrl,
      protocolVersion: z.literal("2025-06-18"),
      toolName: nonempty,
    })
    .strict(),
]);
export type Implementation = z.infer<typeof Implementation>;
export type HttpImplementation = Extract<Implementation, { kind: "http" }>;
/** Conservative object-root proof; does not alter the schema or solve arbitrary satisfiability. */
export function schemaHasObjectRoot(root: JSONSchema): boolean {
  const active = new Set<object>();
  function prove(schema: unknown, refDepth: number): boolean {
    if (!isJsonObject(schema) || active.has(schema) || refDepth > 10)
      return false;
    active.add(schema);
    let objectOnly =
      schema.nullable !== true &&
      (schema.type === "object" ||
        (Array.isArray(schema.type) &&
          schema.type.length === 1 &&
          schema.type[0] === "object"));
    if (
      !objectOnly &&
      typeof schema.$ref === "string" &&
      schema.$ref.startsWith("#/")
    ) {
      let target: unknown = root;
      try {
        for (const token of decodeURIComponent(schema.$ref.slice(2)).split(
          "/",
        )) {
          if (
            /~(?![01])/.test(token) ||
            typeof target !== "object" ||
            target === null
          ) {
            target = undefined;
            break;
          }
          const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
          target = own(target, key)
            ? (target as Record<string, unknown>)[key]
            : undefined;
        }
        objectOnly = prove(target, refDepth + 1);
      } catch {
        objectOnly = false;
      }
    }
    if (!objectOnly && Array.isArray(schema.allOf))
      objectOnly = schema.allOf.some((branch) => prove(branch, refDepth));
    for (const key of ["oneOf", "anyOf"])
      if (!objectOnly && Array.isArray(schema[key])) {
        const branches = schema[key].filter((branch) => branch !== false);
        objectOnly =
          branches.length > 0 &&
          branches.every((branch) => prove(branch, refDepth));
      }
    active.delete(schema);
    return objectOnly;
  }
  return prove(root, 0);
}
const objectRoot = JsonSchema.refine(
  schemaHasObjectRoot,
  "Tool schema must provably restrict its root to objects",
);
export const ToolDefinition = z
  .object({
    name: IntegrationToolName,
    upstreamName: nonempty.optional(),
    description: text(4096),
    inputSchema: objectRoot,
    outputSchema: objectRoot.optional(),
    operationClass: OperationClass,
    requirements: record(RequirementName, Requirement, 8),
    permissions: z.array(Permission),
    implementation: Implementation,
  })
  .strict()
  .refine(
    (v) =>
      v.permissions.every(
        (p) => p.requirement === null || own(v.requirements, p.requirement),
      ),
    "Permission refers to undeclared requirement",
  );
export type ToolDefinition = z.infer<typeof ToolDefinition>;
const nameMapping = record(nonempty, IntegrationToolName, 500);
const authored = <K extends "typescript" | "http">(kind: K) =>
  z
    .object({ kind: z.literal(kind), tools: z.array(ToolDefinition).max(500) })
    .strict()
    .refine((v) => {
      if (
        !v.tools.every((t) => t.implementation.kind === kind) ||
        new Set(v.tools.map((t) => t.name)).size !== v.tools.length
      )
        return false;
      const nodes = new Set<object>();
      for (const tool of v.tools) {
        const schemas: JSONSchema[] = [tool.inputSchema];
        if (tool.outputSchema !== undefined) schemas.push(tool.outputSchema);
        if (tool.implementation.kind === "http") {
          schemas.push(...tool.implementation.parameters.map((p) => p.schema));
          if (tool.implementation.requestBody)
            schemas.push(tool.implementation.requestBody.schema);
          if (tool.implementation.response.schema !== undefined)
            schemas.push(tool.implementation.response.schema);
          for (const response of Object.values(
            tool.implementation.response.statuses ?? {},
          ))
            if (response.schema !== undefined) schemas.push(response.schema);
        }
        if (schemas.some((schema) => schemaStructureProblem(schema, nodes)))
          return false;
      }
      return true;
    }, "Implementation kind mismatch, duplicate Tool or aggregate schema-node bound exceeded");
export const Source = z.discriminatedUnion("kind", [
  authored("typescript"),
  authored("http"),
  z
    .object({
      kind: z.literal("openapi"),
      document: bytes(M2_LIMITS.documentBytes),
      approvedRefOrigins: unique(PermissionOrigin),
      serverUrl: httpsUrl.optional(),
      nameMapping,
      securityMappings: record(
        nonempty,
        z
          .object({
            requirement: RequirementName,
            requirementDefinition: Requirement,
          })
          .strict(),
      ),
      operationOptions: record(
        nonempty,
        z
          .object({
            requestMediaType: nonempty.optional(),
            responseMediaType: nonempty.optional(),
            securityAlternative: z.number().int().nonnegative().optional(),
          })
          .strict(),
        500,
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote_mcp"),
      endpoint: httpsUrl,
      accountId: uuid.optional(),
      namespace: IntegrationSlug,
      nameMapping,
    })
    .strict(),
]);
export type Source = z.infer<typeof Source>;
export const RevisionSummary = z
  .object({
    revisionId: uuid,
    createdAt: date,
    status: z.enum(["draft", "published", "superseded"]),
    digest: hash,
    available: z.boolean(),
  })
  .strict();
export type RevisionSummary = z.infer<typeof RevisionSummary>;
export const ReviewDiagnostic = z
  .object({
    upstreamName: nonempty,
    path: text(4096).refine(
      (p) => p === "" || (p.startsWith("/") && !/~(?![01])/.test(p)),
      "Source JSON Pointer required",
    ),
    code: z.enum(["excluded_media", "schema_warning"]),
    message: text(512),
  })
  .strict();
export type ReviewDiagnostic = z.infer<typeof ReviewDiagnostic>;
export const ReviewReport = z
  .object({
    integrationId: uuid,
    draftRevisionId: uuid,
    reportDigest: hash,
    accepted: z.array(ToolDefinition).max(500),
    rejected: z
      .array(
        z
          .object({
            upstreamName: nonempty,
            path: text(4096),
            code: nonempty,
            message: text(512),
          })
          .strict(),
      )
      .max(500),
    diagnostics: z.array(ReviewDiagnostic).optional(),
    changes: z
      .array(
        z
          .object({
            tool: IntegrationToolName,
            kind: z.enum(["new", "unchanged", "changed", "removed"]),
          })
          .strict(),
      )
      .max(1000),
    affectedProfiles: z.array(
      z
        .object({
          profileId: uuid,
          revision: z.number().int().nonnegative(),
          grantCount: z.number().int().nonnegative(),
          tools: unique(IntegrationToolName),
        })
        .strict(),
    ),
  })
  .strict();
export type ReviewReport = z.infer<typeof ReviewReport>;

// HTTP carries validated schema documents as data, not recursively inferred
// validators. Domain validation still uses JsonSchema and ToolDefinition above.
const JsonSchemaDocument = z.union([
  z.boolean(),
  z.record(z.string(), z.unknown()),
]);
const HttpResponseDocument = z
  .object({
    ...HttpResponseContract.shape,
    schema: JsonSchemaDocument.optional(),
  })
  .strict();
const HttpImplementationDocument = z
  .object({
    ...Implementation.options[1].shape,
    parameters: z.array(
      z
        .object({
          ...HttpParameter.shape,
          schema: JsonSchemaDocument,
        })
        .strict(),
    ),
    requestBody: z
      .object({
        ...Implementation.options[1].shape.requestBody.unwrap().shape,
        schema: JsonSchemaDocument,
      })
      .strict()
      .optional(),
    response: HttpResponseDocument.extend({
      statuses: z.record(z.string(), HttpResponseDocument).optional(),
    }).strict(),
  })
  .strict();
const ToolDefinitionDocument = z
  .object({
    ...ToolDefinition.shape,
    inputSchema: JsonSchemaDocument,
    outputSchema: JsonSchemaDocument.optional(),
    implementation: z.discriminatedUnion("kind", [
      Implementation.options[0],
      HttpImplementationDocument,
      Implementation.options[2],
    ]),
  })
  .strict();
export const ReviewReportDocument = z
  .object({
    ...ReviewReport.shape,
    accepted: z.array(ToolDefinitionDocument).max(500),
  })
  .strict();
export type ReviewReportDocument = z.infer<typeof ReviewReportDocument>;
export const AccountIdentity = z
  .object({
    subject: nonempty,
    issuer: nonempty.optional(),
    audience: nonempty.optional(),
    tenant: nonempty.optional(),
    application: nonempty.optional(),
  })
  .strict();
export type AccountIdentity = z.infer<typeof AccountIdentity>;
export const Credential = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bearer"), token: bytes(65536).min(1) }).strict(),
  z.object({ kind: z.literal("api_key"), value: bytes(65536).min(1) }).strict(),
  z
    .object({
      kind: z.literal("basic"),
      username: bytes(65536),
      password: bytes(65536),
    })
    .strict(),
]);
export type Credential = z.infer<typeof Credential>;
export const AccountAlias = text(128, 1).refine(
  (s) => !hasCodeUnitInRange(s, 0, 31) && !hasCodeUnitInRange(s, 127, 159),
  "Alias must not contain controls",
);
const ownership = z.enum(["user", "workspace"]);
export const AccountView = z
  .object({
    accountId: uuid,
    provider: RequirementName,
    alias: AccountAlias,
    ownership,
    ownerUserId: nonempty.nullable(),
    method: AuthMethod,
    identity: AccountIdentity,
    scopes: unique(nonempty),
    enabled: z.boolean(),
    health: z.enum(["unverified", "healthy", "expired", "revoked", "error"]),
    expiresAt: date.nullable(),
    createdAt: date,
  })
  .strict()
  .refine(
    (v) =>
      v.ownership === "workspace"
        ? v.ownerUserId === null
        : v.ownerUserId !== null,
    "Ownership and owner identity mismatch",
  );
export type AccountView = z.infer<typeof AccountView>;
export const CreateAccountInput = z
  .object({
    provider: RequirementName,
    alias: AccountAlias,
    ownership,
    method: AuthMethod,
    identity: AccountIdentity,
    scopes: unique(nonempty),
    credential: Credential.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.method !== "oauth2" &&
      (v.method === "none"
        ? v.credential === undefined
        : v.credential?.kind === v.method),
    "Manual method requires matching credential; OAuth uses callback",
  );
export type CreateAccountInput = z.infer<typeof CreateAccountInput>;
export const PatchAccountInput = z
  .object({
    alias: AccountAlias.optional(),
    enabled: z.boolean().optional(),
    credential: Credential.optional(),
  })
  .strict();
export type PatchAccountInput = z.infer<typeof PatchAccountInput>;
const bindingKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}\.[a-z][a-z0-9_]{0,63}$/);
export const AccountBindings = record(bindingKey, uuid);
export const ProfilePublication = z
  .object({
    profileId: uuid,
    expectedRevision: z.number().int().nonnegative(),
    tools: unique(IntegrationToolName),
    bindings: AccountBindings,
    policies: z.array(
      z
        .object({
          pattern: PolicyPattern,
          decision: z.enum(["allow", "ask", "block"]),
        })
        .strict(),
    ),
  })
  .strict();
export type ProfilePublication = z.infer<typeof ProfilePublication>;
const profiles = z
  .array(ProfilePublication)
  .refine(
    (v) => new Set(v.map((p) => p.profileId)).size === v.length,
    "Repeated Profile",
  );
export const PublishIntegrationInput = z
  .object({
    draftRevisionId: uuid,
    reportDigest: hash,
    expectedCurrentRevisionId: uuid.nullable(),
    profiles,
  })
  .strict();
export type PublishIntegrationInput = z.infer<typeof PublishIntegrationInput>;
export const RollbackIntegrationInput = z
  .object({
    revisionId: uuid,
    reportDigest: hash,
    expectedCurrentRevisionId: uuid.nullable(),
    profiles,
  })
  .strict();
export type RollbackIntegrationInput = z.infer<typeof RollbackIntegrationInput>;
export const Publication = z
  .object({
    integrationId: uuid,
    revisionId: uuid,
    profiles: z.array(
      z
        .object({ profileId: uuid, revision: z.number().int().nonnegative() })
        .strict(),
    ),
  })
  .strict();
export type Publication = z.infer<typeof Publication>;
export const CreateIntegrationInput = z
  .object({ slug: IntegrationSlug, displayName: text(128, 1), source: Source })
  .strict()
  .refine(
    (v) =>
      v.source.kind === "remote_mcp"
        ? v.source.namespace === v.slug &&
          Object.values(v.source.nameMapping).every((n) =>
            n.startsWith(v.slug + "."),
          )
        : v.source.kind === "openapi"
          ? Object.values(v.source.nameMapping).every((n) =>
              n.startsWith(v.slug + "."),
            )
          : v.source.tools.every((t) => t.name.startsWith(v.slug + ".")),
    "Tool namespace must equal integration slug",
  );
export type CreateIntegrationInput = z.infer<typeof CreateIntegrationInput>;
export const ValidateIntegrationInput = z
  .object({ draftRevisionId: uuid })
  .strict();
export const RefreshIntegrationInput = z
  .object({ source: Source.optional() })
  .strict();
export const PatchIntegrationInput = z
  .object({
    enabled: z.boolean().optional(),
    displayName: text(128, 1).optional(),
  })
  .strict();
export const IntegrationDraft = z
  .object({ integrationId: uuid, draftRevisionId: uuid })
  .strict();
export const IntegrationView = z
  .object({
    integrationId: uuid,
    slug: IntegrationSlug,
    displayName: text(128, 1),
    enabled: z.boolean(),
    currentRevisionId: uuid.nullable(),
    drafts: z.array(RevisionSummary),
    revisions: z.array(RevisionSummary),
  })
  .strict();
export const ProfileView = z
  .object({
    profileId: uuid,
    label: text(128, 1),
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    tools: unique(IntegrationToolName),
    bindings: AccountBindings,
  })
  .strict();
export const UpdateBindingsInput = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    bindings: AccountBindings,
  })
  .strict();
export const ProfileRevision = z
  .object({ profileId: uuid, revision: z.number().int().nonnegative() })
  .strict();
const OAuthScopeToolImpact = z
  .object({
    name: IntegrationToolName,
    requirement: RequirementName,
    currentScopesSatisfied: z.boolean(),
    requestedScopesSufficient: z.boolean(),
  })
  .strict();
const OAuthScopeProfileImpact = z
  .object({
    profileId: uuid,
    label: text(128, 1),
    tools: z.array(OAuthScopeToolImpact),
  })
  .strict();
export const OAuthScopeImpact = z
  .object({
    accountId: uuid.nullable(),
    currentScopes: unique(nonempty),
    requestedScopes: unique(nonempty),
    published: z.array(OAuthScopeProfileImpact),
    proposed: z
      .object({
        integrationId: uuid,
        draftRevisionId: uuid,
        callable: z.literal(false),
        profiles: z.array(OAuthScopeProfileImpact),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OAuthScopeImpact = z.infer<typeof OAuthScopeImpact>;
export const OAuthStartInput = z
  .object({
    provider: RequirementName,
    alias: AccountAlias,
    ownership,
    accountId: uuid.optional(),
    scopes: unique(nonempty),
    review: z
      .object({
        integrationId: uuid,
        draftRevisionId: uuid,
        profileIds: unique(uuid, undefined, 1),
      })
      .strict()
      .optional(),
    returnPath: nonempty.refine(
      (s) =>
        s.startsWith("/api/control/") &&
        !/[\\#]/.test(s) &&
        !hasCodeUnitInRange(s, 0, 32) &&
        !/%(?:2f|5c|00|2e)/i.test(s) &&
        new URL(s, "https://example.com").pathname === s.split("?")[0],
      "Safe relative control-plane return path required",
    ),
  })
  .strict();
export const OAuthStartResult = z
  .object({
    authorizationUrl: httpsUrl,
    expiresAt: date,
    impact: OAuthScopeImpact,
  })
  .strict();
export const OAuthCallbackInput = z
  .object({ code: bytes(65536).min(1), state: bytes(1024).min(1) })
  .strict();
export const ArtifactInput = z.object({ artifact_id: uuid }).strict();
export type ArtifactInput = z.infer<typeof ArtifactInput>;
export const ArtifactRef = z
  .object({
    artifact_id: uuid,
    media_type: z
      .string()
      .max(256)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    size_bytes: z.number().int().min(0).max(M2_LIMITS.artifactBytes),
    sha256: hash,
    filename: text(128, 1).refine(
      (s) =>
        !/[/\\]/.test(s) &&
        !hasCodeUnitInRange(s, 0, 31) &&
        !hasCodeUnitInRange(s, 127, 159) &&
        s !== "." &&
        s !== "..",
      "Safe basename required",
    ),
    expires_at: date,
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRef>;
export const ArtifactUploadQuery = z
  .object({ profileId: uuid, grantId: uuid })
  .strict();
export const BusinessMcpResult = z
  .object({
    content: z
      .array(
        z
          .object({ type: z.literal("text"), text: bytes(M2_LIMITS.jsonBytes) })
          .strict(),
      )
      .max(100000),
    structuredContent: JsonObject.optional(),
    isError: z.boolean().optional(),
    _meta: JsonObject.optional(),
  })
  .strict()
  .refine(
    (v) => !v._meta || !own(v._meta, EXECUTION_META_NAMESPACE),
    "Reserved gateway metadata collision",
  )
  .refine(
    (v) => !jsonProblem(v),
    "Complete business result exceeds JSON limit",
  );
export type BusinessMcpResult = z.infer<typeof BusinessMcpResult>;
export const ProtectedMcpResult = z
  .object({ format: z.literal("mcp"), result: BusinessMcpResult })
  .strict();
export const EffectEvidence = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_dispatched") }).strict(),
  z
    .object({ state: z.literal("verified_no_effect"), reason: text(512, 1) })
    .strict(),
  z
    .object({
      state: z.literal("completed"),
      providerRequestId: nonempty.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("possible"),
      providerRequestId: nonempty.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("provider_idempotent"),
      provider: RequirementName,
      key: nonempty,
      expiresAt: date,
    })
    .strict(),
]);
export type EffectEvidence = z.infer<typeof EffectEvidence>;
export const FrozenTool = z
  .object({
    toolId: uuid,
    name: IntegrationToolName,
    toolRevision: nonempty,
    integrationId: uuid,
    integrationRevision: nonempty,
    artifactDigest: hash,
    definition: ToolDefinition,
  })
  .strict()
  .refine((v) => v.name === v.definition.name, "Frozen name mismatch");
export type FrozenTool = z.infer<typeof FrozenTool>;
export const SelectedAccount = z
  .object({
    accountId: uuid,
    identityDigest: hash,
    alias: AccountAlias,
    requirement: RequirementName,
  })
  .strict();
export type SelectedAccount = z.infer<typeof SelectedAccount>;
export const M2FingerprintPayload = z
  .object({
    version: z.literal("m2"),
    organization_id: nonempty,
    grant_id: nonempty,
    profile_id: nonempty,
    tool: IntegrationToolName,
    tool_revision: nonempty,
    integration_revision: nonempty,
    accounts: record(
      RequirementName,
      z.object({ account_id: nonempty, identity_digest: hash }).strict(),
      8,
    ),
    options: z.object({}).strict(),
    arguments: JsonObject,
  })
  .strict();
export type M2FingerprintPayload = z.infer<typeof M2FingerprintPayload>;
export type ValidateIntegrationInput = z.infer<typeof ValidateIntegrationInput>;
export type RefreshIntegrationInput = z.infer<typeof RefreshIntegrationInput>;
export type PatchIntegrationInput = z.infer<typeof PatchIntegrationInput>;
export type IntegrationDraft = z.infer<typeof IntegrationDraft>;
export type IntegrationView = z.infer<typeof IntegrationView>;
export type ProfileView = z.infer<typeof ProfileView>;
export type UpdateBindingsInput = z.infer<typeof UpdateBindingsInput>;
export type ProfileRevision = z.infer<typeof ProfileRevision>;
export type OAuthStartInput = z.infer<typeof OAuthStartInput>;
export type OAuthStartResult = z.infer<typeof OAuthStartResult>;
export type OAuthCallbackInput = z.infer<typeof OAuthCallbackInput>;
export type ArtifactUploadQuery = z.infer<typeof ArtifactUploadQuery>;
export type ProtectedMcpResult = z.infer<typeof ProtectedMcpResult>;
export type AccountBindings = z.infer<typeof AccountBindings>;
export const AccountList = z
  .object({ accounts: z.array(AccountView) })
  .strict();
export type AccountList = z.infer<typeof AccountList>;
export const AccountIdentityFingerprint = z
  .object({
    provider: RequirementName,
    ownership,
    owner_user_id: nonempty.nullable(),
    method: AuthMethod,
    subject: nonempty,
    issuer: nonempty.nullable(),
    audience: nonempty.nullable(),
    tenant: nonempty.nullable(),
    application: nonempty.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.ownership === "workspace"
        ? v.owner_user_id === null
        : v.owner_user_id !== null,
    "Ownership and owner identity mismatch",
  );
export type AccountIdentityFingerprint = z.infer<
  typeof AccountIdentityFingerprint
>;
export type RemoteMcpSource = Extract<Source, { kind: "remote_mcp" }>;
export type OpenApiSource = Extract<Source, { kind: "openapi" }>;
export type HttpSource = Extract<Source, { kind: "http" }>;
export type TypeScriptSource = Extract<Source, { kind: "typescript" }>;
export type ReviewRejected = ReviewReport["rejected"][number];
