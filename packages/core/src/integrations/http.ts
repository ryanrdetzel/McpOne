import {
  BusinessMcpResult,
  type EffectEvidence,
  type FrozenTool,
  type HttpImplementation,
  type HttpSource,
  hasCodeUnitInRange,
  isJsonObject,
  type JSONSchema,
  type JSONValue,
  jsonProblem,
  type ReviewDiagnostic,
  type ReviewRejected,
  type ToolDefinition,
  ToolDefinition as ToolDefinitionSchema,
} from "@scaffold/schema/integrations";
import { canonicalJson } from "../execution/canonical.js";
import { parseStrictJson } from "../strict-json.js";
import type { ArtifactRunContext, ArtifactService } from "./artifacts.js";
import type { TrustedBroker } from "./broker.js";
import { createDerivedMetadataCounter } from "./derived-budget.js";
import {
  failImport,
  ImportError,
  jsonPointer,
  readBounded,
} from "./reference-resolver.js";
import { validateInput, validateSchema } from "./schema.js";

export type SourceWarning = { path: string; code: string; message: string };
export interface HttpResolution {
  accepted: ToolDefinition[];
  rejected: ReviewRejected[];
  warnings: SourceWarning[];
  diagnostics: ReviewDiagnostic[];
}
const encoder = new TextEncoder();
const forbiddenHeader =
  /^(?:host|authorization|proxy-authorization|cookie|set-cookie|connection|content-length|transfer-encoding|forwarded|x-forwarded-.*|proxy-connection|upgrade|te|trailer|content-encoding|content-type|accept|accept-encoding)$/i;
export function mediaKind(
  media: string,
): "json" | "text" | "form" | "multipart" | "binary" {
  if (
    media === "application/json" ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(media)
  )
    return "json";
  if (media === "text/plain") return "text";
  if (media === "application/x-www-form-urlencoded") return "form";
  if (media === "multipart/form-data") return "multipart";
  if (
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(media) &&
    !/(?:event-stream|ndjson|json-seq)$/.test(media)
  )
    return "binary";
  return failImport(
    "unsupported_feature",
    "",
    "Unsupported or live-streaming media type",
  );
}
export function artifactSchema(schema: unknown): boolean {
  if (
    !isJsonObject(schema) ||
    !(
      schema.type === "object" ||
      (Array.isArray(schema.type) &&
        schema.type.length === 1 &&
        schema.type[0] === "object")
    ) ||
    schema.additionalProperties !== false ||
    !isJsonObject(schema.properties) ||
    Object.keys(schema.properties).length !== 1 ||
    !Array.isArray(schema.required) ||
    schema.required.length !== 1 ||
    schema.required[0] !== "artifact_id"
  )
    return false;
  const id = schema.properties.artifact_id;
  return isJsonObject(id) && id.type === "string" && id.format === "uuid";
}
function artifactArraySchema(schema: unknown): boolean {
  if (!isJsonObject(schema)) return false;
  return (
    (schema.type === "array" ||
      (Array.isArray(schema.type) &&
        schema.type.length === 1 &&
        schema.type[0] === "array")) &&
    artifactSchema(schema.items)
  );
}
const scalarTypes: Record<string, true> = {
  string: true,
  number: true,
  integer: true,
  boolean: true,
};
function scalarSerializationSchema(schema: unknown): boolean {
  if (!isJsonObject(schema) || schema.nullable === true) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return (
    types.length > 0 &&
    types.every(
      (type) => typeof type === "string" && Object.hasOwn(scalarTypes, type),
    )
  );
}
export function assertFlatSchema(
  schema: JSONSchema,
  location: "parameter" | "form" | "multipart",
  path: string,
): void {
  if (!isJsonObject(schema))
    failImport(
      "unsupported_schema",
      path,
      "Serialization requires an explicitly typed schema",
    );
  if (location === "multipart" && artifactSchema(schema)) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    !types.length ||
    schema.nullable === true ||
    types.some(
      (type) =>
        typeof type !== "string" ||
        (!Object.hasOwn(scalarTypes, type) &&
          type !== "array" &&
          type !== "object"),
    )
  )
    failImport(
      "unsupported_schema",
      path,
      "Null or unknown types are unsupported by flat serialization",
    );
  if (scalarSerializationSchema(schema)) return;
  if (
    types.includes("array") &&
    !scalarSerializationSchema(schema.items) &&
    !(location === "multipart" && artifactSchema(schema.items))
  )
    failImport(
      "unsupported_schema",
      path,
      "Arrays must contain nonnull scalar values or multipart files",
    );
  if (types.includes("object")) {
    if (schema.properties !== undefined && !isJsonObject(schema.properties))
      failImport(
        "unsupported_schema",
        path,
        "Flat object properties must be a schema map",
      );
    if (location === "multipart" && schema.additionalProperties !== false)
      failImport(
        "unsupported_schema",
        path,
        "Multipart requires explicitly declared part names",
      );
    if (isJsonObject(schema.additionalProperties))
      assertFlatSchema(
        schema.additionalProperties as JSONSchema,
        location === "parameter" ? "parameter" : "form",
        jsonPointer(path, "additionalProperties"),
      );
    for (const [key, value] of Object.entries(
      isJsonObject(schema.properties) ? schema.properties : {},
    )) {
      if (!isJsonObject(value))
        failImport(
          "unsupported_schema",
          jsonPointer(path, key),
          "Flat field schema required",
        );
      if (location === "parameter") {
        if (!scalarSerializationSchema(value))
          failImport(
            "unsupported_schema",
            jsonPointer(path, key),
            "Parameter objects must contain nonnull scalars",
          );
      } else {
        const childTypes = Array.isArray(value.type)
          ? value.type
          : [value.type];
        if (
          childTypes.includes("object") &&
          !(location === "multipart" && artifactSchema(value))
        )
          failImport(
            "unsupported_schema",
            jsonPointer(path, key),
            "Nested form objects are unsupported",
          );
        assertFlatSchema(value as JSONSchema, location, jsonPointer(path, key));
      }
    }
    return;
  }
  if (types.includes("array")) return;
  failImport(
    "unsupported_schema",
    path,
    "Unsupported flat serialization schema",
  );
}
function schemaAtBase(schema: JSONSchema, prefix: string): JSONSchema {
  if (typeof schema === "boolean") return schema;
  const result: Record<string, JSONValue> = { ...schema };
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#"))
    result.$ref = `#${prefix}${schema.$ref.slice(1)}`;
  for (const key of ["properties", "$defs"])
    if (isJsonObject(schema[key])) {
      const children: Record<string, JSONValue> = Object.create(null);
      for (const [name, child] of Object.entries(schema[key]))
        children[name] = schemaAtBase(child as JSONSchema, prefix);
      result[key] = children;
    }
  for (const key of ["items", "additionalProperties"])
    if (typeof schema[key] === "boolean" || isJsonObject(schema[key]))
      result[key] = schemaAtBase(schema[key] as JSONSchema, prefix);
  for (const key of ["allOf", "oneOf", "anyOf"])
    if (Array.isArray(schema[key]))
      result[key] = schema[key].map((branch) =>
        schemaAtBase(branch as JSONSchema, prefix),
      );
  if (
    isJsonObject(schema.discriminator) &&
    isJsonObject(schema.discriminator.mapping)
  ) {
    const mapping: Record<string, JSONValue> = Object.create(null);
    for (const [tag, target] of Object.entries(schema.discriminator.mapping))
      mapping[tag] =
        typeof target === "string" && target.startsWith("#")
          ? `#${prefix}${target.slice(1)}`
          : (target as JSONValue);
    result.discriminator = { ...schema.discriminator, mapping } as JSONValue;
  }
  return result;
}
/** Builds strict location wrappers without changing the upstream field/body constraints. */
export function httpInputSchema(
  implementation: HttpImplementation,
): JSONSchema {
  const properties: Record<string, JSONValue> = Object.create(null),
    required: string[] = [];
  for (const [location, field] of [
    ["path", "path"],
    ["query", "query"],
    ["header", "headers"],
  ] as const) {
    const parameters = implementation.parameters.filter(
      (parameter) => parameter.in === location,
    );
    if (!parameters.length) continue;
    const fields: Record<string, JSONValue> = Object.create(null);
    const needed: string[] = [];
    for (const parameter of parameters) {
      fields[parameter.name] = schemaAtBase(
        parameter.schema,
        jsonPointer(
          jsonPointer("/properties", field) + "/properties",
          parameter.name,
        ),
      );
      if (parameter.required) needed.push(parameter.name);
    }
    properties[field] = {
      type: "object",
      properties: fields,
      additionalProperties: false,
      ...(needed.length ? { required: needed } : {}),
    };
    if (needed.length) required.push(field);
  }
  if (implementation.requestBody) {
    properties.body = schemaAtBase(
      implementation.requestBody.schema,
      "/properties/body",
    );
    if (implementation.requestBody.required) required.push("body");
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  };
}
export function normalizeHttpTool(definition: ToolDefinition): {
  tool: ToolDefinition;
  warnings: SourceWarning[];
} {
  const parsed = ToolDefinitionSchema.safeParse(definition);
  if (!parsed.success || definition.implementation.kind !== "http")
    failImport(
      "import_invalid",
      "",
      "HTTP Tool definition is structurally invalid",
    );
  const implementation = definition.implementation;
  const dialect = implementation.dialect ?? "3.1",
    warnings: SourceWarning[] = [];
  function review(
    schema: JSONSchema,
    direction: "request" | "response",
    path: string,
    reportWarnings = true,
  ): void {
    const result = validateSchema(schema, { dialect, direction });
    if (!result.valid) {
      const issue = result.issues[0]!;
      const issuePath = issue.schemaPath.startsWith("#")
        ? decodeURIComponent(issue.schemaPath.slice(1))
        : issue.schemaPath;
      failImport(issue.code, path + issuePath, issue.message);
    }
    if (reportWarnings)
      for (const issue of result.warnings) {
        const issuePath = issue.schemaPath.startsWith("#")
          ? decodeURIComponent(issue.schemaPath.slice(1))
          : issue.schemaPath;
        warnings.push({
          path: path + issuePath,
          code: issue.code,
          message: issue.message,
        });
      }
  }
  let url: URL;
  try {
    url = new URL(implementation.url.replace(/\{[^{}]+\}/g, "m2_parameter"));
  } catch {
    return failImport(
      "import_invalid",
      "/implementation/url",
      "HTTP operation requires an absolute HTTPS URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search ||
    hasCodeUnitInRange(implementation.url, 0, 32) ||
    implementation.url.includes("\\") ||
    url.href !== implementation.url.replace(/\{[^{}]+\}/g, "m2_parameter")
  )
    failImport(
      "import_invalid",
      "/implementation/url",
      "HTTP operation URL must be reviewed canonical HTTPS without query or credentials",
    );
  const names = new Set<string>();
  const placeholders = [...implementation.url.matchAll(/\{([^{}]+)\}/g)].map(
    (match) => match[1],
  );
  for (const [index, parameter] of implementation.parameters.entries()) {
    const key = `${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;
    if (names.has(key))
      failImport(
        "import_invalid",
        "/implementation/parameters",
        "Duplicate parameter identity",
      );
    names.add(key);
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(parameter.name) &&
      parameter.in === "header"
    )
      failImport(
        "unsupported_feature",
        "/implementation/parameters",
        "Invalid header name",
      );
    if (parameter.in === "header" && forbiddenHeader.test(parameter.name))
      failImport(
        "unsupported_feature",
        "/implementation/parameters",
        "Authentication and routing headers cannot be parameters",
      );
    if (
      parameter.in === "path" &&
      (!parameter.required || !placeholders.includes(parameter.name))
    )
      failImport(
        "import_invalid",
        "/implementation/parameters",
        "Path parameter must match a required URL placeholder",
      );
    assertFlatSchema(
      parameter.schema,
      "parameter",
      `/implementation/parameters/${index}/schema`,
    );
    review(
      parameter.schema,
      "request",
      `/implementation/parameters/${index}/schema`,
    );
  }
  if (
    /[{}]/.test(implementation.url.replace(/\{[^{}]+\}/g, "")) ||
    placeholders.some((name) => !names.has(`path:${name}`)) ||
    /\{/.test(implementation.url.split("/").slice(0, 3).join("/"))
  )
    failImport(
      "import_invalid",
      "/implementation/url",
      "Every URL placeholder requires a declared path parameter",
    );
  if (implementation.requestBody) {
    if (["GET", "HEAD"].includes(implementation.method))
      failImport(
        "unsupported_feature",
        "/implementation/requestBody",
        "GET and HEAD request bodies are unsupported",
      );
    const kind = mediaKind(implementation.requestBody.mediaType);
    if (kind === "binary")
      failImport(
        "unsupported_feature",
        "/implementation/requestBody",
        "Binary request bodies must use artifact-backed multipart",
      );
    if (
      kind === "text" &&
      (!isJsonObject(implementation.requestBody.schema) ||
        !(
          implementation.requestBody.schema.type === "string" ||
          (Array.isArray(implementation.requestBody.schema.type) &&
            implementation.requestBody.schema.type.length === 1 &&
            implementation.requestBody.schema.type[0] === "string")
        ))
    )
      failImport(
        "unsupported_schema",
        "/implementation/requestBody",
        "Text bodies require string schema",
      );
    if (kind === "form" || kind === "multipart") {
      const schema = implementation.requestBody.schema;
      if (
        !isJsonObject(schema) ||
        !(
          schema.type === "object" ||
          (Array.isArray(schema.type) &&
            schema.type.length === 1 &&
            schema.type[0] === "object")
        )
      )
        failImport(
          "unsupported_schema",
          "/implementation/requestBody",
          "Forms require flat object schemas",
        );
      assertFlatSchema(schema, kind, "/implementation/requestBody");
    }
    review(
      implementation.requestBody.schema,
      "request",
      "/implementation/requestBody/schema",
    );
  }
  const inputSchema = httpInputSchema(implementation);
  review(definition.inputSchema, "request", "/inputSchema");
  review(inputSchema, "request", "/inputSchema", false);
  // Both authored and generated constraints survive; do not silently replace stricter manual input constraints.
  const combined: JSONSchema =
    canonicalJson(definition.inputSchema) === canonicalJson(inputSchema)
      ? inputSchema
      : {
          type: "object",
          allOf: [
            schemaAtBase(definition.inputSchema, "/allOf/0"),
            schemaAtBase(inputSchema, "/allOf/1"),
          ],
        };
  review(combined, "request", "/inputSchema", false);
  const contracts = implementation.response.statuses
    ? Object.entries(implementation.response.statuses)
    : [["", implementation.response] as const];
  for (const [status, contract] of contracts) {
    const path = status
      ? jsonPointer("/implementation/response/statuses", status)
      : "/implementation/response";
    const kind = mediaKind(contract.mediaType);
    if (kind === "form" || kind === "multipart")
      failImport(
        "unsupported_feature",
        path,
        "Form and multipart response streams are unsupported",
      );
    if (contract.schema !== undefined)
      review(contract.schema, "response", path + "/schema");
  }
  if (definition.outputSchema)
    review(definition.outputSchema, "response", "/outputSchema");
  return { tool: { ...definition, inputSchema: combined }, warnings };
}
export function resolveHttpTools(source: HttpSource): HttpResolution {
  const budget = createDerivedMetadataCounter();
  const accepted: ToolDefinition[] = [],
    rejected: ReviewRejected[] = [],
    warnings: SourceWarning[] = [],
    diagnostics: ReviewDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [index, definition] of source.tools.entries()) {
    if (seen.has(definition.name))
      failImport(
        "name_collision",
        "",
        "Duplicate Tool names require explicit mapping",
      );
    seen.add(definition.name);
    const upstreamName = definition.upstreamName ?? definition.name;
    try {
      const normalized = normalizeHttpTool(definition);
      budget.add(normalized.tool);
      accepted.push(normalized.tool);
      for (const warning of normalized.warnings) {
        const path = `/tools/${index}${warning.path}`,
          diagnostic: ReviewDiagnostic = {
            upstreamName,
            path,
            code: "schema_warning",
            message: warning.message,
          };
        budget.add(diagnostic);
        warnings.push({ ...warning, path });
        diagnostics.push(diagnostic);
      }
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      const rejection: ReviewRejected = {
        upstreamName,
        path: `/tools/${index}${error.path}`,
        code: error.code,
        message: error.message,
      };
      budget.add(rejection);
      rejected.push(rejection);
    }
  }
  return { accepted, rejected, warnings, diagnostics };
}
export class HttpInvocationError extends Error {
  constructor(
    readonly code: string,
    readonly effect: EffectEvidence,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HttpInvocationError";
  }
}
const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value))
    return canonicalJson(value);
  throw new HttpInvocationError(
    "invalid_arguments",
    { state: "not_dispatched" },
    "Flat HTTP values must be finite nonnull scalars",
  );
}
function orderedEntries(
  value: Record<string, unknown>,
  schema: JSONSchema,
): [string, unknown][] {
  const properties =
    isJsonObject(schema) && isJsonObject(schema.properties)
      ? schema.properties
      : {};
  return [
    ...Object.keys(properties).filter((key) => Object.hasOwn(value, key)),
    ...Object.keys(value)
      .filter((key) => !Object.hasOwn(properties, key))
      .sort(),
  ].map((key) => [key, value[key]]);
}
export function serializeHttpArguments(
  tool: ToolDefinition,
  args: Record<string, JSONValue>,
): {
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  multipart?: Record<string, JSONValue>;
} {
  if (tool.implementation.kind !== "http")
    throw new HttpInvocationError(
      "invalid_arguments",
      { state: "not_dispatched" },
      "HTTP implementation required",
    );
  const implementation = tool.implementation,
    dialect = implementation.dialect ?? "3.1";
  if (
    !validateInput(tool.inputSchema, args, { dialect, direction: "request" })
      .valid ||
    !validateInput(httpInputSchema(implementation), args, {
      dialect,
      direction: "request",
    }).valid
  )
    throw new HttpInvocationError(
      "invalid_arguments",
      { state: "not_dispatched" },
      "HTTP arguments do not match the reviewed schema",
    );
  let url = implementation.url;
  const headers: Record<string, string> = Object.create(null);
  const query: [string, string][] = [];
  const queryKeys = new Set<string>();
  function pair(key: string, value: string, repeat = false): void {
    if (queryKeys.has(key) && !repeat)
      throw new HttpInvocationError(
        "invalid_arguments",
        { state: "not_dispatched" },
        "Expanded query parameter keys collide",
      );
    queryKeys.add(key);
    query.push([rfc3986(key), value]);
  }
  const declaredQuery = new Set(
    implementation.parameters
      .filter((p) => p.in === "query")
      .map((p) => p.name),
  );
  for (const parameter of implementation.parameters) {
    const container =
      args[parameter.in === "header" ? "headers" : parameter.in];
    if (!isJsonObject(container) || !Object.hasOwn(container, parameter.name))
      continue;
    const value = container[parameter.name];
    const encode =
      parameter.in === "header"
        ? scalar
        : (v: unknown) => {
            const text = scalar(v);
            if (parameter.in === "path" && /[/\\]/.test(text))
              throw new HttpInvocationError(
                "invalid_arguments",
                { state: "not_dispatched" },
                "Path values cannot create ambiguous permission paths",
              );
            return rfc3986(text);
          };
    let serialized: string;
    if (Array.isArray(value)) {
      if (parameter.in === "query" && parameter.explode) {
        value.forEach((item, index) => {
          pair(parameter.name, encode(item), index > 0);
        });
        continue;
      }
      serialized = value.map(encode).join(",");
    } else if (isJsonObject(value)) {
      const entries = orderedEntries(value, parameter.schema);
      if (parameter.in === "query" && parameter.explode) {
        for (const [key, item] of entries) {
          if (declaredQuery.has(key))
            throw new HttpInvocationError(
              "invalid_arguments",
              { state: "not_dispatched" },
              "Expanded query property collides with a declared parameter",
            );
          pair(key, encode(item));
        }
        continue;
      }
      serialized = entries
        .map(([key, item]) =>
          parameter.explode
            ? `${parameter.in === "header" ? key : rfc3986(key)}=${encode(item)}`
            : `${parameter.in === "header" ? key : rfc3986(key)},${encode(item)}`,
        )
        .join(",");
    } else serialized = encode(value);
    if (parameter.in === "path")
      url = url.replaceAll(`{${parameter.name}}`, serialized);
    else if (parameter.in === "query") pair(parameter.name, serialized);
    else {
      if (
        /[\r\n\0]/.test(serialized) ||
        encoder.encode(serialized).length > 8192
      )
        throw new HttpInvocationError(
          "invalid_arguments",
          { state: "not_dispatched" },
          "HTTP header value is invalid or oversized",
        );
      headers[parameter.name] = serialized;
    }
  }
  if (/[{}]/.test(url) || new URL(url).href !== url)
    throw new HttpInvocationError(
      "invalid_arguments",
      { state: "not_dispatched" },
      "Path serialization cannot normalize or escape the reviewed endpoint",
    );
  if (query.length)
    url += `?${query.map(([key, value]) => `${key}=${value}`).join("&")}`;
  let body: Uint8Array | undefined,
    multipart: Record<string, JSONValue> | undefined;
  if (implementation.requestBody && Object.hasOwn(args, "body")) {
    const kind = mediaKind(implementation.requestBody.mediaType),
      value = args.body;
    if (kind === "json") body = encoder.encode(canonicalJson(value));
    else if (kind === "text") body = encoder.encode(value as string);
    else if (kind === "form") {
      const form = new URLSearchParams();
      for (const [key, item] of orderedEntries(
        value as Record<string, unknown>,
        implementation.requestBody.schema,
      ))
        for (const part of Array.isArray(item) ? item : [item])
          form.append(key, scalar(part));
      body = encoder.encode(form.toString());
    } else if (kind === "multipart")
      multipart = value as Record<string, JSONValue>;
    if (body && body.length > 1048576)
      throw new HttpInvocationError(
        "payload_too_large",
        { state: "not_dispatched" },
        "HTTP inline body exceeds 1 MiB",
      );
  }
  headers.Accept = [
    ...new Set(
      Object.values(
        implementation.response.statuses ?? {
          generic: implementation.response,
        },
      ).map((contract) => contract.mediaType),
    ),
  ].join(", ");
  if (
    Object.entries(headers).reduce(
      (size, [key, value]) =>
        size + encoder.encode(`${key}: ${value}\r\n`).length,
      0,
    ) > 16384
  )
    throw new HttpInvocationError(
      "payload_too_large",
      { state: "not_dispatched" },
      "HTTP request headers exceed 16 KiB",
    );
  return {
    url,
    headers,
    ...(body ? { body } : {}),
    ...(multipart ? { multipart } : {}),
  };
}
export async function validateHttpArtifactInputs(input: {
  tool: ToolDefinition;
  arguments: Record<string, JSONValue>;
  artifacts: { service: ArtifactService; context: ArtifactRunContext };
}): Promise<
  {
    artifact_id: string;
    metadataDigest: string;
    targetRequirement: string | null;
  }[]
> {
  const serialized = serializeHttpArguments(input.tool, input.arguments);
  if (
    !serialized.multipart ||
    input.tool.implementation.kind !== "http" ||
    !input.tool.implementation.requestBody
  )
    return [];
  const properties = (
    input.tool.implementation.requestBody.schema as Record<string, JSONValue>
  ).properties as Record<string, JSONSchema>;
  const requirement = Object.keys(input.tool.requirements)[0] ?? null;
  const result: {
    artifact_id: string;
    metadataDigest: string;
    targetRequirement: string | null;
  }[] = [];
  for (const [name, value] of orderedEntries(
    serialized.multipart,
    input.tool.implementation.requestBody.schema,
  )) {
    const schema = properties[name];
    if (!artifactSchema(schema) && !artifactArraySchema(schema)) continue;
    for (const file of Array.isArray(value) ? value : [value]) {
      if (result.length >= 10)
        throw new HttpInvocationError(
          "payload_too_large",
          { state: "not_dispatched" },
          "Multipart supports at most ten file parts",
        );
      const ref = file as { artifact_id: string };
      result.push({
        artifact_id: ref.artifact_id,
        metadataDigest: await input.artifacts.service.metadataDigest(
          input.artifacts.context,
          ref,
          requirement,
        ),
        targetRequirement: requirement,
      });
    }
  }
  return result;
}
export interface HttpInvokeInput {
  runId: string;
  claimId: string;
  tool: FrozenTool;
  arguments: Record<string, JSONValue>;
  deadlineMs: number;
  broker: TrustedBroker;
  artifacts?: { service: ArtifactService; context: ArtifactRunContext };
}
function redactHttpJson(
  value: JSONValue,
  redact: (text: string) => string,
  effect: EffectEvidence,
): JSONValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactHttpJson(item, redact, effect));
  if (value !== null && typeof value === "object") {
    const safe: Record<string, JSONValue> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (redact(key) !== key)
        throw new HttpInvocationError(
          "unsupported_result",
          effect,
          "Upstream JSON contains sensitive object identifiers",
        );
      safe[key] = redactHttpJson(value[key]!, redact, effect);
    }
    return safe;
  }
  return value;
}

export async function invokeHttpTool(
  input: HttpInvokeInput,
): Promise<{ result: BusinessMcpResult; effect: EffectEvidence }> {
  const candidate = input.tool.definition.implementation;
  if (candidate.kind !== "http")
    throw new HttpInvocationError(
      "invalid_arguments",
      { state: "not_dispatched" },
      "HTTP implementation required",
    );
  const implementation = candidate;
  if (
    input.artifacts &&
    (input.artifacts.context.runId !== input.runId ||
      input.artifacts.context.claimId !== input.claimId ||
      input.artifacts.context.executionDeadline !== input.deadlineMs)
  )
    throw new HttpInvocationError(
      "forbidden",
      { state: "not_dispatched" },
      "Artifact capability must match the authoritative Run and claim",
    );
  const serialized = serializeHttpArguments(
      input.tool.definition,
      input.arguments,
    ),
    requirements = Object.keys(input.tool.definition.requirements);
  const needsBinary =
    implementation.method !== "HEAD" &&
    Object.entries(
      implementation.response.statuses ?? { generic: implementation.response },
    ).some(
      ([status, contract]) =>
        status !== "204" && mediaKind(contract.mediaType) === "binary",
    );
  async function dispatch(
    body?: Uint8Array,
    mediaType?: string,
  ): Promise<{ result: BusinessMcpResult; effect: EffectEvidence }> {
    if (Date.now() >= input.deadlineMs)
      throw new HttpInvocationError(
        "execution_timeout",
        input.broker.effect(),
        "The frozen execution deadline has elapsed",
      );
    const response = await input.broker.requestRaw({
      accountRequirement: requirements.length === 1 ? requirements[0]! : null,
      ...(requirements.length > 1 ? { accountRequirements: requirements } : {}),
      method: implementation.method,
      url: serialized.url,
      headers: serialized.headers,
      ...(body ? { body } : {}),
      ...(mediaType ? { mediaType } : {}),
      maxResponseBytes: needsBinary ? 26214400 : 1048576,
    });
    if (Date.now() >= input.deadlineMs) {
      await response.body?.cancel();
      throw new HttpInvocationError(
        "execution_timeout",
        input.broker.effect(),
        "The frozen execution deadline elapsed while awaiting the upstream response",
      );
    }
    const effect = input.broker.effect();
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpInvocationError(
        response.status >= 500 ? "upstream_unavailable" : "upstream_rejected",
        effect,
        "The upstream service rejected or could not complete the reviewed request",
      );
    }
    const contract = implementation.response.statuses
      ? (implementation.response.statuses[String(response.status)] ??
        implementation.response.statuses.default)
      : implementation.response;
    if (!contract) {
      await response.body?.cancel();
      throw new HttpInvocationError(
        "unsupported_result",
        effect,
        "Response status has no reviewed contract",
      );
    }
    if (implementation.method === "HEAD" || response.status === 204) {
      await response.body?.cancel();
      return { result: { content: [] }, effect: { state: "completed" } };
    }
    const actual = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)"?/i
      .exec(response.headers.get("content-type") ?? "")?.[1]
      ?.toLowerCase();
    if (
      charset &&
      !["utf-8", "utf8"].includes(charset) &&
      mediaKind(contract.mediaType) !== "binary"
    ) {
      await response.body?.cancel();
      throw new HttpInvocationError(
        "unsupported_result",
        effect,
        "Only UTF-8 inline response text is supported",
      );
    }
    if (
      actual !== contract.mediaType ||
      (response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity")
    ) {
      await response.body?.cancel();
      throw new HttpInvocationError(
        "unsupported_result",
        effect,
        "Response media type or encoding does not match the reviewed contract",
      );
    }
    let result: BusinessMcpResult;
    if (mediaKind(contract.mediaType) === "binary") {
      if (!input.artifacts) {
        await response.body?.cancel();
        throw new HttpInvocationError(
          "unsupported_result",
          effect,
          "Protected artifact storage is required for binary results",
        );
      }
      const artifact = await input.artifacts.service.createFromResponse(
        input.artifacts.context,
        response,
        { mediaType: contract.mediaType },
      );
      const value = { artifact };
      result = {
        content: [{ type: "text", text: canonicalJson(value) }],
        structuredContent: value,
      };
    } else {
      const bytes = await readBounded(
        response,
        1048576,
        AbortSignal.timeout(Math.max(1, input.deadlineMs - Date.now())),
      );
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      let value: unknown = text;
      if (mediaKind(contract.mediaType) === "json") {
        value = parseStrictJson(text);
        if (jsonProblem(value))
          throw new HttpInvocationError(
            "unsupported_result",
            effect,
            "Upstream JSON is not bounded finite Unicode JSON",
          );
      }
      value = redactHttpJson(
        value as JSONValue,
        input.broker.redact.bind(input.broker),
        effect,
      );
      if (jsonProblem(value))
        throw new HttpInvocationError(
          "unsupported_result",
          effect,
          "Redacted upstream output is not bounded finite Unicode JSON",
        );
      if (
        contract.schema !== undefined &&
        !validateInput(contract.schema, value, {
          dialect: implementation.dialect ?? "3.1",
          direction: "response",
        }).valid
      )
        throw new HttpInvocationError(
          "unsupported_result",
          effect,
          "Upstream output does not match the reviewed response schema",
        );
      if (
        input.tool.definition.outputSchema !== undefined &&
        !validateInput(input.tool.definition.outputSchema, value, {
          dialect: implementation.dialect ?? "3.1",
          direction: "response",
        }).valid
      )
        throw new HttpInvocationError(
          "unsupported_result",
          effect,
          "Upstream output does not match the reviewed Tool output schema",
        );
      result = {
        content: [
          {
            type: "text",
            text:
              typeof value === "string" &&
              mediaKind(contract.mediaType) === "text"
                ? value
                : canonicalJson(value),
          },
        ],
        ...(isJsonObject(value)
          ? { structuredContent: value as Record<string, JSONValue> }
          : {}),
      };
    }
    if (mediaKind(contract.mediaType) === "binary") {
      if (
        contract.schema !== undefined &&
        !validateInput(contract.schema, result.structuredContent, {
          dialect: implementation.dialect ?? "3.1",
          direction: "response",
        }).valid
      )
        throw new HttpInvocationError(
          "unsupported_result",
          effect,
          "Protected artifact output does not match the reviewed response schema",
        );
      if (
        input.tool.definition.outputSchema !== undefined &&
        !validateInput(
          input.tool.definition.outputSchema,
          result.structuredContent,
          { dialect: implementation.dialect ?? "3.1", direction: "response" },
        ).valid
      )
        throw new HttpInvocationError(
          "unsupported_result",
          effect,
          "Protected artifact output does not match the reviewed Tool schema",
        );
    }
    if (!BusinessMcpResult.safeParse(result).success)
      throw new HttpInvocationError(
        "payload_too_large",
        effect,
        "The complete business result exceeds the MCP response budget",
      );
    return { result, effect: { state: "completed" } };
  }
  async function execute(): Promise<{
    result: BusinessMcpResult;
    effect: EffectEvidence;
  }> {
    if (!serialized.multipart)
      return dispatch(
        serialized.body,
        serialized.body ? implementation.requestBody?.mediaType : undefined,
      );
    if (!input.artifacts || !implementation.requestBody)
      throw new HttpInvocationError(
        "invalid_arguments",
        { state: "not_dispatched" },
        "Multipart requires authorized artifact storage",
      );
    const bodySchema = implementation.requestBody.schema as Record<
      string,
      JSONValue
    >;
    const properties = bodySchema.properties as Record<string, JSONSchema>;
    const parts: { name: string; value: JSONValue; file: boolean }[] = [];
    const refs: { artifact_id: string }[] = [];
    let minimumOverhead = 0;
    for (const [name, value] of orderedEntries(
      serialized.multipart,
      implementation.requestBody.schema,
    )) {
      if (/[\r\n\0"\\]/.test(name))
        throw new HttpInvocationError(
          "invalid_arguments",
          { state: "not_dispatched" },
          "Multipart field name is unsafe",
        );
      const schema = properties[name];
      const file = artifactSchema(schema) || artifactArraySchema(schema);
      for (const item of Array.isArray(value) ? value : [value]) {
        minimumOverhead += encoder.encode(
          `--mcpone_${"0".repeat(32)}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n\r\n`,
        ).length;
        if (minimumOverhead > 65536)
          throw new HttpInvocationError(
            "payload_too_large",
            { state: "not_dispatched" },
            "Multipart exceeds its MIME overhead budget",
          );
        parts.push({ name, value: item as JSONValue, file });
        if (file) refs.push(item as { artifact_id: string });
      }
    }
    return input.artifacts.service.withMultipartFiles(
      input.artifacts.context,
      refs,
      requirements[0] ?? null,
      async (files) => {
        const boundary = `mcpone_${crypto.randomUUID().replaceAll("-", "")}`;
        const chunks: Uint8Array[] = [];
        let fileIndex = 0,
          inline = 0,
          overhead = 0,
          total = 0;
        function append(bytes: Uint8Array): void {
          chunks.push(bytes);
          total += bytes.length;
        }
        for (const part of parts) {
          const file = part.file ? files[fileIndex++] : undefined;
          const prefix = encoder.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${file ? `; filename="${file.ref.filename.replaceAll('"', "_")}"\r\nContent-Type: ${file.ref.media_type}` : ""}\r\n\r\n`,
          );
          overhead += prefix.length + 2;
          if (overhead > 65536)
            throw new HttpInvocationError(
              "payload_too_large",
              { state: "not_dispatched" },
              "Multipart exceeds its MIME overhead budget",
            );
          append(prefix);
          if (file) append(file.bytes);
          else {
            const bytes = encoder.encode(scalar(part.value));
            inline += bytes.length;
            append(bytes);
          }
          append(encoder.encode("\r\n"));
        }
        const end = encoder.encode(`--${boundary}--\r\n`);
        overhead += end.length;
        append(end);
        if (inline > 1048576 || overhead > 65536 || total > 27328512)
          throw new HttpInvocationError(
            "payload_too_large",
            { state: "not_dispatched" },
            "Multipart exceeds reviewed file, inline or MIME limits",
          );
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        try {
          return await dispatch(
            body,
            `multipart/form-data; boundary=${boundary}`,
          );
        } finally {
          body.fill(0);
        }
      },
    );
  }
  try {
    if (needsBinary || serialized.multipart) {
      if (!input.artifacts)
        throw new HttpInvocationError(
          "unsupported_result",
          { state: "not_dispatched" },
          "Protected artifact service is required",
        );
      return await input.artifacts.service.withBinaryAdmission(
        input.artifacts.context,
        execute,
      );
    }
    return await execute();
  } catch (error) {
    if (error instanceof HttpInvocationError) throw error;
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "unsupported_result";
    throw new HttpInvocationError(
      code,
      input.broker.effect(),
      "The reviewed HTTP invocation could not produce a valid bounded result",
      error instanceof Error &&
        "retryable" in error &&
        error.retryable === true,
    );
  }
}
