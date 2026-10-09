#!/usr/bin/env node
/** Public deterministic D12 fixtures. No credentials, network calls, or substitute validators. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
export const CONTRACT_VERSION = "0.2.2-m2";
export const PROTOCOL_VERSION = "2025-06-18";
export const EXECUTION_NAMESPACE = "com.toolcontrolplane/execution";
export const FALLBACK_PREFIX = "Tool Control Plane execution: ";
export const LIMITS = Object.freeze({
  inlineBytes: 1024 * 1024,
  specBytes: 5 * 1024 * 1024,
  derivedMetadataBytes: 8 * 1024 * 1024,
  binaryBytes: 25 * 1024 * 1024,
  uploadFiles: 10,
  operations: 500,
  referenceDepth: 10,
  schemaDepth: 32,
  compositionBranches: 8,
  compositionDepth: 4,
  referenceOccurrences: 1000,
  referenceDocuments: 16,
  referenceAggregateBytes: 20 * 1024 * 1024,
  referenceRedirects: 3,
  referenceFetchMs: 10_000,
  referenceTotalMs: 30_000,
  schemaNodes: 10_000,
  schemaProperties: 256,
  schemaEnum: 256,
  validationVisits: 100_000,
  multipartOverheadBytes: 64 * 1024,
  multipartTotalBytes: 27_328_512,
  requirements: 8,
  sourceBytes: 256 * 1024,
  moduleClosureBytes: 1024 * 1024,
  modules: 32,
  outboundRequests: 30,
  safeAttempts: 3,
  nfaStates: 65_536,
  processingWork: 10_000_000,
});

export const metadataFixtures = [
  { name: "absent optional IDs", valid: true, value: {} },
  {
    name: "printable boundary IDs remain exact",
    valid: true,
    value: { idempotency_key: " !~ ", trace_id: "Z".repeat(128) },
  },
  { name: "empty ID", valid: false, value: { idempotency_key: "" } },
  { name: "oversized ID", valid: false, value: { trace_id: "x".repeat(129) } },
  {
    name: "control character",
    valid: false,
    value: { idempotency_key: "a\nb" },
  },
  { name: "DEL character", valid: false, value: { trace_id: "\u007f" } },
  { name: "non ASCII", valid: false, value: { idempotency_key: "é" } },
  { name: "non string ID", valid: false, value: { idempotency_key: 1 } },
  { name: "null ID", valid: false, value: { trace_id: null } },
  { name: "legacy alias", valid: false, value: { _idempotency_key: "legacy" } },
  {
    name: "caller selected Account is not metadata",
    valid: false,
    value: { accounts: { provider: "friendly" } },
  },
  {
    name: "caller supplied Run ID",
    valid: false,
    value: { run_id: "run-public" },
  },
];

export const resultMetadataFixtures = [
  {
    name: "no Accounts",
    valid: true,
    value: { run_id: "run-public", tool: "sample.notes.read" },
  },
  {
    name: "multiple friendly aliases",
    valid: true,
    value: {
      run_id: "run-public",
      tool: "sample.notes.copy",
      accounts: { source: "Personal notes", target: "Team notes" },
    },
  },
  {
    name: "status belongs to fallback",
    valid: false,
    value: {
      run_id: "run-public",
      tool: "sample.notes.read",
      status: "succeeded",
    },
  },
  {
    name: "version is not metadata",
    valid: false,
    value: {
      run_id: "run-public",
      tool: "sample.notes.read",
      version: CONTRACT_VERSION,
    },
  },
  {
    name: "credential field",
    valid: false,
    value: {
      run_id: "run-public",
      tool: "sample.notes.read",
      access_token: "obvious-public-placeholder",
    },
  },
  {
    name: "noncanonical Tool",
    valid: false,
    value: { run_id: "run-public", tool: "Sample/read" },
  },
  {
    name: "empty alias",
    valid: false,
    value: {
      run_id: "run-public",
      tool: "sample.notes.read",
      accounts: { source: "" },
    },
  },
];

export const schemaFixtures = [
  {
    name: "strict object and unmodified defaults",
    valid: true,
    schema: {
      type: "object",
      properties: {
        value: { type: "integer", minimum: 0, default: 3 },
        label: { type: "string", minLength: 1, maxLength: 64 },
      },
      required: ["label"],
      additionalProperties: false,
    },
    accepted: [{ label: "public" }],
    rejected: [
      { label: "" },
      { label: "public", extra: true },
      { label: "public", value: -1 },
    ],
    unchanged: { label: "public" },
  },
  {
    name: "3.1 nullable union",
    valid: true,
    schema: { type: ["string", "null"] },
    accepted: [null, "public"],
    rejected: [3],
  },
  {
    name: "bounded enum array",
    valid: true,
    schema: {
      type: "array",
      items: { type: "string", enum: ["read", "write"] },
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    },
    accepted: [["read", "write"]],
    rejected: [[], ["read", "read"], ["admin"]],
  },
  {
    name: "oneOf disjoint explicit tags",
    valid: true,
    schema: {
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "read" }, id: { type: "string" } },
          required: ["kind", "id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "write" }, value: { type: "integer" } },
          required: ["kind", "value"],
          additionalProperties: false,
        },
      ],
    },
    accepted: [
      { kind: "read", id: "public" },
      { kind: "write", value: 1 },
    ],
    rejected: [{ kind: "read", value: 1 }],
  },
  {
    name: "allOf constraints",
    valid: true,
    schema: {
      allOf: [
        { type: "number", minimum: 0 },
        { type: "number", maximum: 10 },
      ],
    },
    accepted: [5],
    rejected: [-1, 11],
  },
  {
    name: "anyOf constraints",
    valid: true,
    schema: {
      anyOf: [
        { type: "string", minLength: 2 },
        { type: "integer", minimum: 1 },
      ],
    },
    accepted: ["ok", 2],
    rejected: ["", false],
  },
  {
    name: "annotations confer no authority",
    valid: true,
    schema: {
      type: "string",
      title: "Public value",
      description: "Untrusted annotation",
      "x-authority": "admin",
    },
    accepted: ["public"],
    rejected: [1],
  },
  {
    name: "conditional validation unsupported",
    valid: false,
    schema: JSON.parse(
      '{"type":"object","if":{"properties":{"kind":{"const":"write"}}},"then":{"required":["value"]}}',
    ),
  },
  {
    name: "tuple unsupported",
    valid: false,
    schema: { type: "array", prefixItems: [{ type: "string" }] },
  },
  {
    name: "patternProperties unsupported",
    valid: false,
    schema: { type: "object", patternProperties: { ".*": { type: "string" } } },
  },
  {
    name: "dynamic reference unsupported",
    valid: false,
    schema: { $dynamicRef: "#node" },
  },
  {
    name: "unknown format unsupported",
    valid: false,
    schema: { type: "string", format: "provider-token" },
  },
  {
    name: "unknown validation keyword",
    valid: false,
    schema: { type: "string", maxBytes: 2 },
  },
  {
    name: "composition branch bound",
    valid: false,
    schema: { anyOf: Array.from({ length: 9 }, () => ({ type: "string" })) },
  },
  {
    name: "cyclic local references",
    valid: false,
    schema: { $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" },
  },
  {
    name: "private external reference",
    valid: false,
    schema: { $ref: "https://127.0.0.1/secret.json" },
  },
  {
    name: "unknown required property",
    valid: false,
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["missing"],
      additionalProperties: false,
    },
  },
];

function referenceChain(depth) {
  const definitions = {};
  for (let index = 0; index < depth; index++)
    definitions[`r${index}`] =
      index === depth - 1
        ? { type: "string" }
        : { $ref: `#/$defs/r${index + 1}` };
  return { $defs: definitions, $ref: "#/$defs/r0" };
}
function schemaChain(depth) {
  let schema = { type: "string" };
  for (let index = 0; index < depth; index++)
    schema = { type: "array", items: schema };
  return schema;
}
function compositionChain(depth) {
  let schema = { type: "integer" };
  for (let index = 0; index < depth; index++) schema = { allOf: [schema] };
  return schema;
}
const visitBoundary = {
  type: "array",
  items: {
    oneOf: [
      { type: "integer" },
      ...Array.from({ length: 7 }, (_, index) => ({
        const: `excluded-${index}`,
      })),
    ],
  },
};
schemaFixtures.push(
  {
    name: "additionalProperties schema",
    valid: true,
    schema: {
      type: "object",
      additionalProperties: { type: "integer" },
      minProperties: 1,
      maxProperties: 2,
    },
    accepted: [{ first: 0 }, { first: 1, second: 2 }],
    rejected: [{}, { first: "1" }, { a: 1, b: 2, c: 3 }],
  },
  {
    name: "additionalProperties absent remains permissive",
    valid: true,
    schema: { type: "object", properties: { known: { type: "string" } } },
    accepted: [{ known: "public", arbitrary: [1, true, null] }],
    rejected: [{ known: 1 }],
  },
  {
    name: "decimal multipleOf has no epsilon",
    valid: true,
    schema: {
      type: "number",
      multipleOf: 0.1,
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
    },
    accepted: [0.3, 0.9],
    rejected: [0, 1, 0.31, 0.30000000000000004],
  },
  {
    name: "Unicode scalar length",
    valid: true,
    schema: { type: "string", minLength: 1, maxLength: 1 },
    accepted: ["😀", "é"],
    rejected: ["", "ab", "e\u0301"],
  },
  {
    name: "structural enum preserves JSON types",
    valid: true,
    schema: { enum: [{ a: 1, b: 2 }, [1, 2], false, null] },
    accepted: [{ b: 2, a: 1 }, [1, 2], false, null],
    rejected: [{ a: "1", b: 2 }, [2, 1], "false"],
  },
  {
    name: "duplicate enum",
    valid: false,
    schema: {
      enum: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    },
  },
  {
    name: "oneOf zero one and two matches",
    valid: true,
    schema: {
      oneOf: [
        { type: "integer", minimum: 0 },
        { type: "number", maximum: 10 },
      ],
    },
    accepted: [11, -1],
    rejected: [5, "public"],
  },
  {
    name: "anyOf overlapping matches are accepted",
    valid: true,
    schema: { anyOf: [{ type: "integer" }, { type: "number" }] },
    accepted: [1, 1.5],
    rejected: ["1"],
  },
  {
    name: "allOf contradiction is unsatisfiable not ignored",
    valid: true,
    schema: {
      allOf: [
        { type: "number", minimum: 2 },
        { type: "number", maximum: 1 },
      ],
    },
    accepted: [],
    rejected: [0, 1, 2],
  },
  {
    name: "3.0 nullable accepts null",
    dialect: "3.0",
    valid: true,
    schema: { type: "string", nullable: true },
    accepted: ["public", null],
    rejected: [0],
  },
  {
    name: "3.0 nullable does not override enum",
    dialect: "3.0",
    valid: true,
    schema: { type: "string", nullable: true, enum: ["public"] },
    accepted: ["public"],
    rejected: [null],
  },
  {
    name: "3.0 exclusive bounds normalize strictly",
    dialect: "3.0",
    valid: true,
    schema: {
      type: "number",
      minimum: 0,
      maximum: 1,
      exclusiveMinimum: true,
      exclusiveMaximum: true,
    },
    accepted: [0.5],
    rejected: [0, 1],
  },
  {
    name: "3.0 union rejects",
    dialect: "3.0",
    valid: false,
    schema: { type: ["string", "null"] },
  },
  {
    name: "3.0 const rejects",
    dialect: "3.0",
    valid: false,
    schema: { const: "public" },
  },
  {
    name: "3.1 nullable rejects",
    valid: false,
    schema: { type: "string", nullable: true },
  },
  {
    name: "nullable without explicit type rejects",
    dialect: "3.0",
    valid: false,
    schema: { nullable: true },
  },
  {
    name: "request readOnly and required direction",
    direction: "request",
    valid: true,
    schema: {
      type: "object",
      properties: {
        id: { type: "string", readOnly: true },
        password: { type: "string", writeOnly: true },
      },
      required: ["id", "password"],
      additionalProperties: false,
    },
    accepted: [{ password: "public" }],
    rejected: [{}, { id: "public", password: "public" }],
  },
  {
    name: "response writeOnly and required direction",
    direction: "response",
    valid: true,
    schema: {
      type: "object",
      properties: {
        id: { type: "string", readOnly: true },
        password: { type: "string", writeOnly: true },
      },
      required: ["id", "password"],
      additionalProperties: false,
    },
    accepted: [{ id: "public" }],
    rejected: [{}, { id: "public", password: "public" }],
  },
  {
    name: "readOnly and writeOnly together reject",
    valid: false,
    schema: { type: "string", readOnly: true, writeOnly: true },
  },
  {
    name: "safe unanchored linear pattern",
    valid: true,
    schema: { type: "string", pattern: "ab+" },
    accepted: ["xxabbbzz"],
    rejected: ["xxazz"],
  },
  {
    name: "safe anchored linear pattern",
    valid: true,
    schema: { type: "string", pattern: "^[a-z]{1,3}$" },
    accepted: ["a", "abc"],
    rejected: ["abcd", "A", "zaaa!"],
  },
  ...[
    "(a+)+",
    "a|b",
    "(?=a)",
    "(a)\\1",
    "\\p{L}+",
    "a{1025}",
    "x".repeat(257),
  ].map((pattern, index) => ({
    name: `unsafe pattern ${index}`,
    valid: false,
    schema: { type: "string", pattern },
  })),
  {
    name: "calendar-valid date",
    valid: true,
    schema: { type: "string", format: "date" },
    accepted: ["2024-02-29"],
    rejected: ["2023-02-29", "2024-02-30", "2024-2-01"],
  },
  {
    name: "RFC3339 date-time requires offset",
    valid: true,
    schema: { type: "string", format: "date-time" },
    accepted: ["2024-02-29T12:00:00Z", "2024-02-29T12:00:00+01:00"],
    rejected: ["2024-02-29T12:00:00", "2024-02-29T12:00:60Z"],
  },
  {
    name: "canonical UUID",
    valid: true,
    schema: { type: "string", format: "uuid" },
    accepted: ["00000000-0000-4000-8000-000000000001"],
    rejected: ["00000000000040008000000000000001"],
  },
  {
    name: "ASCII dot-atom email",
    valid: true,
    schema: { type: "string", format: "email" },
    accepted: ["public.fixture@example.com"],
    rejected: [
      "a..b@example.com",
      '"quoted"@example.com',
      "public@localhost",
      "é@example.com",
    ],
  },
  {
    name: "absolute URI",
    valid: true,
    schema: { type: "string", format: "uri" },
    accepted: ["https://example.com/public"],
    rejected: ["/relative", "https://example.com/\n"],
  },
  {
    name: "DNS hostname",
    valid: true,
    schema: { type: "string", format: "hostname" },
    accepted: ["public.example.com"],
    rejected: ["bad_name.example.com", `${"x".repeat(64)}.example.com`],
  },
  {
    name: "canonical IPv4",
    valid: true,
    schema: { type: "string", format: "ipv4" },
    accepted: ["192.0.2.1"],
    rejected: ["192.000.2.1", "0x7f000001", "2130706433", "256.0.0.1"],
  },
  {
    name: "RFC4291 IPv6 without RFC5952 normalization",
    valid: true,
    schema: { type: "string", format: "ipv6" },
    accepted: [
      "2001:db8::1",
      "2001:DB8::1",
      "2001:0db8:0:0:0:0:0:1",
      "::ffff:192.0.2.1",
    ],
    rejected: [
      "2001:::1",
      "127.0.0.1",
      "[2001:db8::1]",
      "fe80::1%eth0",
      "::ffff:192.000.2.1",
    ],
  },
  {
    name: "escaped local reference",
    valid: true,
    schema: { $defs: { "a/b~c": { type: "string" } }, $ref: "#/$defs/a~1b~0c" },
    accepted: ["public"],
    rejected: [0],
  },
  {
    name: "reference depth10",
    standaloneOnly: true,
    valid: true,
    schema: referenceChain(10),
    accepted: ["public"],
    rejected: [0],
  },
  {
    name: "reference depth11",
    standaloneOnly: true,
    valid: false,
    schema: referenceChain(11),
  },
  {
    name: "schema depth32",
    standaloneOnly: true,
    valid: true,
    schema: schemaChain(32),
  },
  {
    name: "schema depth33",
    standaloneOnly: true,
    valid: false,
    schema: schemaChain(33),
  },
  {
    name: "composition depth4",
    valid: true,
    schema: compositionChain(4),
    accepted: [0],
    rejected: ["0"],
  },
  { name: "composition depth5", valid: false, schema: compositionChain(5) },
  {
    name: "composition branches8",
    valid: true,
    schema: {
      oneOf: Array.from({ length: 8 }, (_, index) => ({ const: index })),
    },
    accepted: [0, 7],
    rejected: [8],
  },
  {
    name: "enum256",
    valid: true,
    schema: { enum: Array.from({ length: 256 }, (_, index) => index) },
    accepted: [0, 255],
    rejected: [256],
  },
  {
    name: "enum257",
    valid: false,
    schema: { enum: Array.from({ length: 257 }, (_, index) => index) },
  },
  {
    name: "properties256",
    valid: true,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 256 }, (_, index) => [
          `p${index}`,
          { type: "string" },
        ]),
      ),
    },
  },
  {
    name: "properties257",
    valid: false,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [
          `p${index}`,
          { type: "string" },
        ]),
      ),
    },
  },
  {
    name: "prototype property remains own JSON data",
    valid: true,
    schema: {
      type: "object",
      properties: JSON.parse(
        '{"__proto__":{"type":"object"},"constructor":{"type":"string"}}',
      ),
      additionalProperties: false,
    },
    accepted: [
      JSON.parse('{"__proto__":{"public":"fixture"},"constructor":"data"}'),
    ],
    rejected: [{ extra: true }],
  },
  {
    name: "invalid Unicode in business property",
    valid: true,
    schema: { type: "object" },
    rejected: [JSON.parse('{"\\ud800":"public"}')],
  },
  {
    name: "invalid Unicode in business string",
    valid: true,
    schema: { type: "string" },
    rejected: ["\udfff"],
  },
  {
    name: "validation visits100000",
    standaloneOnly: true,
    valid: true,
    schema: visitBoundary,
    accepted: [Array(11111).fill(0)],
  },
  {
    name: "validation visits100001",
    standaloneOnly: true,
    valid: true,
    schema: { allOf: [visitBoundary] },
    rejected: [Array(11111).fill(0)],
  },
);
schemaFixtures.push(
  {
    name: "true boolean schema",
    valid: true,
    schema: true,
    accepted: [null, 0, "public", {}],
  },
  {
    name: "false boolean schema",
    valid: true,
    schema: false,
    rejected: [null, 0, "public", {}],
  },
  {
    name: "3.0 boolean schema rejects",
    dialect: "3.0",
    valid: false,
    schema: true,
  },
  {
    name: "3.1 ref sibling remains conjunctive",
    valid: true,
    schema: {
      $defs: { number: { type: "number", minimum: 0 } },
      $ref: "#/$defs/number",
      maximum: 1,
    },
    accepted: [0.5],
    rejected: [-1, 2],
  },
  {
    name: "3.0 ref validation sibling rejects",
    dialect: "3.0",
    valid: false,
    schema: { $ref: "#/components/schemas/Public", maximum: 1 },
  },
  {
    name: "nullable enum explicitly admits null",
    dialect: "3.0",
    valid: true,
    schema: { type: "string", nullable: true, enum: ["public", null] },
    accepted: ["public", null],
    rejected: [0],
  },
  {
    name: "invalid default is warning not value injection",
    valid: true,
    warning: true,
    schema: {
      type: "integer",
      default: "not-an-integer",
      examples: ["invalid"],
      title: "Public annotation",
      description: "No authority",
      deprecated: true,
    },
    accepted: [0],
    rejected: ["0"],
  },
  {
    name: "duplicate required rejects",
    valid: false,
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name", "name"],
    },
  },
  {
    name: "duplicate union type rejects",
    valid: false,
    schema: { type: ["string", "string"] },
  },
  {
    name: "negative multipleOf rejects",
    valid: false,
    schema: { type: "number", multipleOf: -1 },
  },
  {
    name: "inverted lengths reject",
    valid: false,
    schema: { type: "string", minLength: 2, maxLength: 1 },
  },
  {
    name: "discriminator disjoint explicit mapping",
    valid: true,
    schema: {
      $defs: {
        read: {
          type: "object",
          properties: { kind: { const: "read" } },
          required: ["kind"],
        },
        write: {
          type: "object",
          properties: { kind: { const: "write" } },
          required: ["kind"],
        },
      },
      oneOf: [{ $ref: "#/$defs/read" }, { $ref: "#/$defs/write" }],
      discriminator: {
        propertyName: "kind",
        mapping: { read: "#/$defs/read", write: "#/$defs/write" },
      },
    },
    accepted: [{ kind: "read" }, { kind: "write" }],
    rejected: [{ kind: "unknown" }],
  },
  {
    name: "discriminator ambiguous tags reject",
    valid: false,
    schema: {
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "same" } },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { kind: { const: "same" } },
          required: ["kind"],
        },
      ],
      discriminator: { propertyName: "kind", mapping: { same: "#/oneOf/0" } },
    },
  },
  {
    name: "unsupported schema dialect rejects",
    valid: false,
    schema: { $schema: "https://example.com/custom-schema", type: "string" },
  },
  {
    name: "schema id cannot change reference base",
    valid: false,
    schema: { $id: "https://example.com/changed-base", type: "object" },
  },
);
schemaFixtures.push(
  {
    name: "mixed anyOf readOnly does not weaken required",
    valid: true,
    direction: "request",
    schema: {
      type: "object",
      properties: {
        x: { anyOf: [{ type: "integer", readOnly: true }, { type: "string" }] },
      },
      required: ["x"],
      additionalProperties: false,
    },
    accepted: [{ x: "a" }],
    rejected: [{}, { x: 1 }],
  },
  {
    name: "allOf guaranteed readOnly relaxes absent required only",
    valid: true,
    direction: "request",
    schema: {
      type: "object",
      properties: { x: { allOf: [{ readOnly: true }, { type: "integer" }] } },
      required: ["x"],
      additionalProperties: false,
    },
    accepted: [{}],
    rejected: [{ x: 1 }],
  },
  {
    name: "successful anyOf readOnly cannot be discarded for writable fallback",
    valid: true,
    direction: "request",
    schema: {
      type: "object",
      properties: {
        x: { anyOf: [{ type: "integer", readOnly: true }, { type: "number" }] },
      },
      required: ["x"],
    },
    accepted: [{ x: 1.5 }],
    rejected: [{}, { x: 1 }],
  },
  {
    name: "composed both directional flags reject",
    valid: false,
    schema: {
      allOf: [{ readOnly: true }, { writeOnly: true }, { type: "string" }],
    },
  },
);

/** Compression framing vectors for the real transport decoder, never a substitute decoder. */
export function compressionFixtures() {
  const payload = Buffer.from("public fixture", "utf8"),
    gzip = gzipSync(payload),
    deflate = deflateSync(payload);
  const corrupt = Buffer.from(gzip);
  corrupt[corrupt.length - 8] ^= 1;
  const oversizedComment = Buffer.concat([
    Buffer.from(gzip.subarray(0, 10)),
    Buffer.alloc(LIMITS.inlineBytes, 120),
    Buffer.from([0]),
    gzip.subarray(10),
  ]);
  oversizedComment[3] |= 0x10;
  return [
    {
      name: "identity",
      encoding: "identity",
      valid: true,
      wire: payload,
      decoded: payload,
    },
    {
      name: "gzip",
      encoding: "gzip",
      valid: true,
      wire: gzip,
      decoded: payload,
    },
    {
      name: "concatenated valid gzip members",
      encoding: "gzip",
      valid: true,
      wire: Buffer.concat([
        gzipSync(Buffer.from("public ")),
        gzipSync(Buffer.from("fixture")),
      ]),
      decoded: payload,
    },
    {
      name: "zlib wrapped deflate",
      encoding: "deflate",
      valid: true,
      wire: deflate,
      decoded: payload,
    },
    {
      name: "raw deflate ambiguity",
      encoding: "deflate",
      valid: false,
      wire: deflateRawSync(payload),
      error: "unsupported_result",
    },
    {
      name: "gzip checksum corruption",
      encoding: "gzip",
      valid: false,
      wire: corrupt,
      error: "unsupported_result",
    },
    {
      name: "truncated gzip",
      encoding: "gzip",
      valid: false,
      wire: gzip.subarray(0, gzip.length - 1),
      error: "unsupported_result",
    },
    {
      name: "gzip malformed trailing bytes",
      encoding: "gzip",
      valid: false,
      wire: Buffer.concat([gzip, Buffer.from([1, 2, 3])]),
      error: "unsupported_result",
    },
    {
      name: "zlib trailing stream",
      encoding: "deflate",
      valid: false,
      wire: Buffer.concat([deflate, deflate]),
      error: "unsupported_result",
    },
    {
      name: "stacked coding",
      encoding: "gzip, deflate",
      valid: false,
      wire: gzip,
      error: "unsupported_result",
    },
    {
      name: "aggregate decoded size bound",
      encoding: "gzip",
      valid: false,
      wire: gzipSync(Buffer.alloc(LIMITS.inlineBytes + 1, 65)),
      error: "payload_too_large",
    },
    {
      name: "aggregate compressed size bound with valid tiny decoded member",
      encoding: "gzip",
      valid: false,
      wire: oversizedComment,
      error: "payload_too_large",
    },
  ];
}

export const fingerprintFixtures = [
  {
    name: "M2 frozen public digest",
    frame: {
      version: "m2",
      organization_id: "org-example",
      grant_id: "grant-example",
      profile_id: "profile-example",
      tool: "github.user.get",
      tool_revision: "tool-v1",
      integration_revision: "integration-v1",
      accounts: {
        github: {
          account_id: "account-example",
          identity_digest: "a".repeat(64),
        },
      },
      options: {},
      arguments: {},
    },
    canonical:
      '{"accounts":{"github":{"account_id":"account-example","identity_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"arguments":{},"grant_id":"grant-example","integration_revision":"integration-v1","options":{},"organization_id":"org-example","profile_id":"profile-example","tool":"github.user.get","tool_revision":"tool-v1","version":"m2"}',
    sha256: "f0615d23b84e984445826029b44f40d81f7123c8b88d0902d01674dad10743c3",
  },
];

export function openApiDocument(version = "3.1.0") {
  return {
    openapi: version,
    info: { title: "Public M2 conformance import", version: "1.0.0" },
    servers: [{ url: "https://example.com" }],
    paths: {
      "/notes/{id}": {
        get: {
          operationId: "readNote",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Read result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
export function openApiFixtures() {
  const unsupported = openApiDocument();
  unsupported.paths["/unsupported"] = {
    get: {
      operationId: "unsupported",
      responses: {
        200: {
          description: "Unsupported",
          content: {
            "application/json": {
              schema: { type: "array", contains: { type: "string" } },
            },
          },
        },
      },
    },
  };
  const cyclic = openApiDocument();
  cyclic.components = {
    schemas: { loop: { $ref: "#/components/schemas/loop" } },
  };
  cyclic.paths["/notes/{id}"].get.responses["200"].content[
    "application/json"
  ].schema = { $ref: "#/components/schemas/loop" };
  const privateRef = openApiDocument();
  privateRef.paths["/notes/{id}"].get.responses["200"].content[
    "application/json"
  ].schema = { $ref: "https://169.254.169.254/latest/meta-data" };
  const tooMany = openApiDocument();
  tooMany.paths = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [
      `/item-${index}`,
      {
        get: {
          operationId: `item${index}`,
          responses: {
            200: {
              description: "Public response",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    ]),
  );
  const atBound = {
    ...tooMany,
    paths: Object.fromEntries(Object.entries(tooMany.paths).slice(0, 500)),
  };
  const selectedMedia = openApiDocument();
  selectedMedia.paths["/notes/{id}"].get.responses["200"].content[
    "application/xml"
  ] = { schema: { type: "string" } };
  const scalarResponse = openApiDocument();
  scalarResponse.paths["/notes/{id}"].get.responses["200"].content[
    "application/json"
  ].schema = { type: "array", items: { type: "integer" } };
  const atBytes = openApiDocument();
  atBytes.info.description = "";
  atBytes.info.description = "x".repeat(
    LIMITS.specBytes - Buffer.byteLength(JSON.stringify(atBytes)),
  );
  const overBytes = {
    ...atBytes,
    info: { ...atBytes.info, description: `${atBytes.info.description}x` },
  };
  const derivedOverflow = {
    ...openApiDocument(),
    components: {
      schemas: {
        Shared: {
          type: "object",
          properties: { public: { type: "boolean" } },
          required: ["public"],
          description: "x".repeat(32 * 1024),
        },
      },
    },
    paths: Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `/expanded-${index}`,
        {
          get: {
            operationId: `expanded${index}`,
            responses: {
              200: {
                description: "Shared response",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Shared" },
                  },
                },
              },
            },
          },
        },
      ]),
    ),
  };
  return [
    { name: "OpenAPI 3.0", valid: true, document: openApiDocument("3.0.3") },
    { name: "OpenAPI 3.1", valid: true, document: openApiDocument() },
    {
      name: "raw HTTP array response is not a scalar MCP outputSchema",
      valid: true,
      document: scalarResponse,
    },
    {
      name: "explicit media selection remains accepted with nonblocking exclusion",
      valid: true,
      document: selectedMedia,
      operationOptions: {
        readNote: { responseMediaType: "application/json" },
      },
      expectedDiagnostic: "excluded_media",
    },
    { name: "operation count500 boundary", valid: true, document: atBound },
    { name: "document5MiB boundary", valid: true, document: atBytes },
    { name: "document5MiB plus1", valid: false, document: overBytes },
    {
      name: "compact legal root500-operation expansion exceeds8MiB derived budget",
      valid: false,
      document: derivedOverflow,
      derivedBudget: true,
    },
    {
      name: "mixed operation review never publishes",
      valid: false,
      reviewOnly: true,
      document: unsupported,
    },
    { name: "cyclic import", valid: false, document: cyclic },
    {
      name: "private resolver destination",
      valid: false,
      document: privateRef,
    },
    { name: "operation bound", valid: false, document: tooMany },
    {
      name: "unsupported version",
      valid: false,
      document: { ...openApiDocument(), openapi: "2.0" },
    },
  ];
}

export const httpSerializationFixtures = [
  {
    name: "path values preserve one unambiguous percent-encoded segment",
    location: "path",
    style: "simple",
    explode: false,
    value: "a b ?#",
    expected: "a%20b%20%3F%23",
  },
  {
    name: "path separator cannot create an ambiguous permission path",
    location: "path",
    style: "simple",
    explode: false,
    value: "a/b",
    valid: false,
  },
  {
    name: "query form repeated array",
    location: "query",
    style: "form",
    explode: true,
    nameKey: "tag",
    value: ["a b", "c+d"],
    expected: "tag=a%20b&tag=c%2Bd",
  },
  {
    name: "query form comma array",
    location: "query",
    style: "form",
    explode: false,
    nameKey: "tag",
    value: ["a", "b"],
    expected: "tag=a,b",
  },
  {
    name: "headers reject CRLF",
    location: "header",
    style: "simple",
    value: "public\r\nAuthorization: injected",
    valid: false,
  },
  {
    name: "authorization header override rejected",
    location: "header",
    nameKey: "Authorization",
    value: "obvious-public-placeholder",
    valid: false,
  },
  {
    name: "cookie override rejected",
    location: "header",
    nameKey: "Cookie",
    value: "public=1",
    valid: false,
  },
];

export const isolationFixtures = [
  {
    name: "direct private destination",
    url: "https://127.0.0.1/",
    allowed: false,
  },
  {
    name: "link-local metadata destination",
    url: "http://169.254.169.254/latest/meta-data",
    allowed: false,
  },
  { name: "IPv6 loopback destination", url: "https://[::1]/", allowed: false },
  {
    name: "credential bearing destination",
    url: "https://public-placeholder@example.com/",
    allowed: false,
  },
  { name: "scheme escape", url: "file:///etc/passwd", allowed: false },
  {
    name: "unreviewed destination",
    url: "https://unreviewed.example.com/",
    allowed: false,
  },
];

export const sandboxFixtures = [
  {
    name: "process environment escape",
    validationCodes: ["typescript_2591"],
    source:
      'export default async function () { return { content: [{ type: "text", text: JSON.stringify(process.env) }] }; }',
  },
  {
    name: "host filesystem dependency",
    source:
      'import { readFileSync } from "node:fs"; export default async function () { return { content: [{ type: "text", text: readFileSync("/etc/passwd", "utf8") }] }; }',
  },
  {
    name: "network dependency loader",
    source:
      'import secret from "https://unreviewed.example.com/escape.js"; export default async function () { return { content: [{ type: "text", text: String(secret) }] }; }',
  },
  {
    name: "direct network bypass",
    validationCodes: ["typescript_2304"],
    source:
      'export default async function () { const response = await fetch("https://127.0.0.1/"); return { content: [{ type: "text", text: await response.text() }] }; }',
  },
  {
    name: "constructor host process escape",
    source:
      'export default async function () { const host = Function("return process")(); return { content: [{ type: "text", text: JSON.stringify(host.env) }] }; }',
  },
  {
    name: "raw broker credential escape",
    source:
      'export default async function (_args, ctx) { return { content: [{ type: "text", text: JSON.stringify(Object.keys(ctx.http.credentials)) }] }; }',
  },
];

/** Generate public manifests for an ACTUAL owned HTTPS controlled fault source. */
export function controlledExternalFixture(origin, namespace) {
  const base = new URL(origin);
  if (
    base.protocol !== "https:" ||
    base.origin !== origin ||
    base.username ||
    base.password
  )
    throw new Error("Fault source needs canonical owned HTTPS origin");
  if (!/^[0-9a-f-]{36}$/i.test(namespace))
    throw new Error("Fault namespace must be an isolated UUID");
  const slug = `fault_${namespace.replaceAll("-", "")}`;
  const endpoint = (action) => `${origin}/${namespace}/${action}`;
  const definition = (action, operationClass, method) => ({
    name: `${slug}.${action}`,
    description: `Controlled external ${action}; not Provider acceptance`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    operationClass,
    requirements: {},
    permissions: [
      {
        requirement: null,
        origin,
        methods: [method],
        path: `/${namespace}/${action}`,
        match: "exact",
      },
    ],
    implementation: {
      kind: "http",
      method,
      url: endpoint(action),
      parameters: [],
      response: { mediaType: "application/json" },
    },
  });
  const safeSlug = `safe_${namespace.replaceAll("-", "")}`;
  const safeTool = `${safeSlug}.before_effect`;
  const permanentAuthorFaultSource = {
    kind: "typescript",
    controlled: true,
    slug: safeSlug,
    displayName: "Permanent authored pre-dispatch fault, not Provider proof",
    accounts: [],
    source: {
      kind: "typescript",
      tools: [
        {
          name: safeTool,
          description:
            "An authored exception before broker send is permanent; absence of effect alone does not establish retryability",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          operationClass: "unknown",
          requirements: {},
          permissions: [],
          implementation: {
            kind: "typescript",
            entrypoint: "default",
            modules: {},
            source:
              'export default async function () { throw new Error("controlled-pre-dispatch-fault"); }',
          },
        },
      ],
    },
    operation: {
      tool: safeTool,
      arguments: {},
      operationClass: "read",
      expected: [],
      observation: { url: endpoint("stats"), pointer: "/writes", delta: 0 },
    },
  };
  const dnsSlug = `dns_${namespace.replaceAll("-", "")}`;
  const dnsTool = `${dnsSlug}.before_http_send`;
  const unavailableOrigin = `https://missing-${namespace}.${base.hostname}`;
  const safeRetrySource = {
    kind: "http",
    controlled: true,
    slug: dnsSlug,
    displayName: "Actual DNS pre-send safe retry, not Provider proof",
    accounts: [],
    source: {
      kind: "http",
      tools: [
        {
          ...definition("before_http_send", "unknown", "GET"),
          name: dnsTool,
          description:
            "Real DNS failure before HTTP bytes; only trusted transport evidence establishes safe retry",
          permissions: [
            {
              requirement: null,
              origin: unavailableOrigin,
              methods: ["GET"],
              path: "/before_http_send",
              match: "exact",
            },
          ],
          implementation: {
            kind: "http",
            method: "GET",
            url: `${unavailableOrigin}/before_http_send`,
            parameters: [],
            response: { mediaType: "application/json" },
          },
        },
      ],
    },
    operation: {
      tool: dnsTool,
      arguments: {},
      operationClass: "read",
      expected: [],
      observation: { url: endpoint("stats"), pointer: "/writes", delta: 0 },
    },
  };
  return {
    capabilities: ["multipart", "binary", "redirects"],
    ...(base.hostname.endsWith(".workers.dev")
      ? { availableRuntimes: ["local"] }
      : {}),
    source: {
      kind: "http",
      controlled: true,
      slug,
      displayName: "Controlled external fault source (not Provider proof)",
      source: {
        kind: "http",
        tools: [
          definition("write", "write", "POST"),
          definition("retryable_read", "read", "GET"),
          definition("oversized_after_write", "write", "POST"),
          definition("timeout_after_write", "write", "POST"),
        ],
      },
      accounts: [],
      operation: {
        tool: `${slug}.write`,
        arguments: {},
        operationClass: "write",
        authorizedDisposableWrite: true,
        expected: [{ pointer: "/structuredContent/incremented", value: 1 }],
        observation: { url: endpoint("stats"), pointer: "/writes", delta: 1 },
      },
    },
    cases: [
      {
        tool: safeTool,
        source: permanentAuthorFaultSource,
        arguments: {},
        operationClass: "unknown",
        status: "failed",
        errorCode: "execution_failed",
        attempts: 1,
        delta: 0,
        effectEvidence: "not_dispatched",
      },
      {
        tool: dnsTool,
        source: safeRetrySource,
        arguments: {},
        operationClass: "unknown",
        status: "failed",
        errorCode: "upstream_unavailable",
        attempts: 3,
        delta: 0,
        effectEvidence: "verified_no_effect",
        outboundRequests: 3,
      },
      {
        tool: `${slug}.oversized_after_write`,
        arguments: {},
        operationClass: "write",
        status: "outcome_unknown",
        attempts: 1,
        delta: 1,
      },
      {
        tool: `${slug}.timeout_after_write`,
        arguments: {},
        operationClass: "write",
        status: "outcome_unknown",
        attempts: 1,
        delta: 1,
      },
    ],
    restart: {
      tool: `${slug}.timeout_after_write`,
      arguments: {},
      operationClass: "write",
      status: "outcome_unknown",
      attempts: 1,
      delta: 1,
    },
  };
}

/** These public recipes contain no token in guest code; custody stays in Accounts. */
export const GITHUB_READ_SOURCE =
  'export default async function (_input, ctx) { const response = await ctx.http.request({accountRequirement:"github",method:"GET",url:"https://api.github.com/user"}); return response.body; }';
export function githubSourceFixtures({
  credential,
  user,
  namespace,
  ownership = "user",
}) {
  if (
    credential?.kind !== "bearer" ||
    typeof credential.token !== "string" ||
    !Number.isSafeInteger(user?.id) ||
    typeof user.login !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(namespace)
  )
    throw new Error(
      "Supply a real disposable bearer credential and separately verified GitHub user, plus isolated UUID",
    );
  const identity = {
    subject: String(user.id),
    issuer: "https://github.com",
    audience: "https://api.github.com",
  };
  const requirement = {
    provider: "github",
    methods: ["bearer", "oauth2"],
    scopes: [],
    issuer: identity.issuer,
    audience: identity.audience,
  };
  return ["typescript", "http", "remote_mcp"].map((kind) => {
    const slug = `github_${kind}_${namespace.replaceAll("-", "")}`,
      name = `${slug}.${kind === "remote_mcp" ? "get_me" : "user"}`;
    const tool = {
      name,
      description: "Read the authenticated disposable GitHub identity",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      operationClass: "read",
      requirements: { github: requirement },
      permissions: [
        {
          requirement: "github",
          origin: "https://api.github.com",
          methods: ["GET"],
          path: "/user",
          match: "exact",
        },
      ],
      implementation:
        kind === "typescript"
          ? {
              kind,
              entrypoint: "default",
              modules: {},
              source: GITHUB_READ_SOURCE,
            }
          : {
              kind: "http",
              method: "GET",
              url: "https://api.github.com/user",
              parameters: [],
              response: { mediaType: "application/json" },
            },
    };
    const document = {
      openapi: "3.1.0",
      info: { title: "Real authorized GitHub identity", version: "1" },
      servers: [{ url: "https://api.github.com" }],
      components: {
        securitySchemes: { githubBearer: { type: "http", scheme: "bearer" } },
      },
      security: [{ githubBearer: [] }],
      paths: {
        "/user": {
          get: {
            description: tool.description,
            responses: {
              200: {
                description: "Authenticated GitHub user",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        login: { type: "string" },
                      },
                      required: ["id", "login"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const openApiSource = (value, extra = false) => ({
      kind: "openapi",
      document: JSON.stringify(value),
      approvedRefOrigins: [],
      nameMapping: {
        "GET /user": name,
        ...(extra ? { "HEAD /user": `${slug}.unpublished_extra` } : {}),
      },
      securityMappings: {
        githubBearer: {
          requirement: "github",
          requirementDefinition: requirement,
        },
      },
      operationOptions: {},
    });
    const source =
      kind === "remote_mcp"
        ? {
            kind,
            endpoint: "https://api.githubcopilot.com/mcp/",
            namespace: slug,
            nameMapping: { get_me: name },
          }
        : kind === "http"
          ? openApiSource(document)
          : { kind, tools: [tool] };
    const requirementName = kind === "remote_mcp" ? "remote" : "github";
    return {
      kind,
      slug,
      displayName: `Real authorized GitHub ${kind}`,
      source,
      discoveryRequirement: requirementName,
      accounts: [
        {
          requirement: requirementName,
          create: {
            provider: "github",
            alias: `Disposable GitHub ${kind}`,
            ownership,
            method: "bearer",
            identity,
            scopes: [],
            credential,
          },
        },
      ],
      operation: {
        tool: name,
        arguments: {},
        operationClass: "read",
        authorizedSubject: { id: user.id, login: user.login },
      },
      ...(kind === "remote_mcp"
        ? {}
        : {
            revisionSource:
              kind === "http"
                ? openApiSource({
                    ...document,
                    paths: {
                      "/user": {
                        get: {
                          ...document.paths["/user"].get,
                          description: `${tool.description}; incompatible changed output only`,
                          responses: {
                            200: {
                              description:
                                "Changed output proves pending old contract is retained",
                              content: {
                                "application/json": {
                                  schema: {
                                    type: "object",
                                    properties: {
                                      __m2_conformance_revision: {
                                        const: "reviewed",
                                      },
                                    },
                                    required: ["__m2_conformance_revision"],
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  })
                : {
                    kind,
                    tools: [
                      {
                        ...tool,
                        description: `${tool.description}; reviewed revision`,
                        implementation: {
                          ...tool.implementation,
                          source: GITHUB_READ_SOURCE.replace(
                            "return response.body;",
                            'return {...response.body,__m2_conformance_revision:"reviewed"};',
                          ),
                        },
                      },
                    ],
                  },
            driftSource:
              kind === "http"
                ? openApiSource(
                    {
                      ...document,
                      paths: {
                        "/user": {
                          ...document.paths["/user"],
                          head: {
                            description: "Unpublished extra authenticated read",
                            responses: { 200: { description: "HEAD only" } },
                          },
                        },
                      },
                    },
                    true,
                  )
                : {
                    kind,
                    tools: [
                      tool,
                      {
                        ...tool,
                        name: `${slug}.unpublished_extra`,
                        description: "Unpublished extra authenticated read",
                      },
                    ],
                  },
          }),
    };
  });
}

// A machine-readable fixture dump is not an implementation conformance pass.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(
      {
        contract_version: CONTRACT_VERSION,
        evidence: "fixture-corpus-only",
        metadata: metadataFixtures,
        result_metadata: resultMetadataFixtures,
        fingerprint: fingerprintFixtures,
        schemas: schemaFixtures,
        openapi: openApiFixtures(),
        http_serialization: httpSerializationFixtures,
        isolation: isolationFixtures,
        sandbox: sandboxFixtures,
      },
      null,
      2,
    ),
  );
}
