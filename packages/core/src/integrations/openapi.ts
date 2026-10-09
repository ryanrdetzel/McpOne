import {
  type HttpImplementation,
  type HttpMethod,
  type HttpParameter,
  hasCodeUnitInRange,
  isJsonObject,
  type JSONSchema,
  type JSONValue,
  type OpenApiSource,
  type Permission,
  type Requirement,
  type ReviewDiagnostic,
  type ReviewRejected,
  schemaStructureProblem,
  type ToolDefinition,
} from "@scaffold/schema/integrations";
import { createDerivedMetadataCounter } from "./derived-budget.js";
import {
  httpInputSchema,
  mediaKind,
  normalizeHttpTool,
  type SourceWarning,
} from "./http.js";
import {
  failImport,
  ImportError,
  jsonPointer,
  type ReferenceDocument,
  type ReferenceOptions,
  referenceSchemaProblem,
  resolveReferences,
  snapshotSchema,
} from "./reference-resolver.js";

export interface OpenApiContext
  extends Omit<ReferenceOptions, "approvedOrigins"> {
  slug: string;
  validateSecurityMapping?: (
    scheme: Record<string, unknown>,
    requirement: Requirement,
  ) => void;
}
export interface OpenApiResolution {
  accepted: ToolDefinition[];
  rejected: ReviewRejected[];
  warnings: SourceWarning[];
  diagnostics: ReviewDiagnostic[];
  manifest: {
    documents: ReferenceDocument[];
    references: { path: string; target: string }[];
    excluded: { path: string; mediaType: string }[];
  };
}
const methods: Record<string, true> = {
  get: true,
  post: true,
  put: true,
  patch: true,
  delete: true,
  head: true,
  options: true,
  trace: true,
};
const supported: Record<string, true> = {
  get: true,
  post: true,
  put: true,
  patch: true,
  delete: true,
  head: true,
};
function object(value: unknown, path: string): Record<string, unknown> {
  if (!isJsonObject(value))
    failImport("import_invalid", path, "Expected an OpenAPI object");
  const problem = referenceSchemaProblem(value as object);
  if (problem) failImport("unsupported_schema", path, problem);
  return value as Record<string, unknown>;
}
function schema(value: unknown, path: string, multipart = false): JSONSchema {
  if (value === undefined)
    failImport("unsupported_schema", path, "Explicit schema is required");
  function inspect(node: unknown): void {
    if (Array.isArray(node)) {
      for (const child of node) inspect(child);
      return;
    }
    if (!isJsonObject(node)) return;
    const problem = referenceSchemaProblem(node);
    if (problem) failImport("unsupported_schema", path, problem);
    for (const child of Object.values(node)) inspect(child);
  }
  inspect(value);
  const snapshotted = snapshotSchema(value);
  if (
    isJsonObject(snapshotted) &&
    snapshotted.$schema === "https://spec.openapis.org/oas/3.1/dialect/base"
  ) {
    snapshotted["x-mcpone-original-dialect"] = snapshotted.$schema;
    snapshotted.$schema = "https://json-schema.org/draft/2020-12/schema";
  }
  if (multipart && isJsonObject(snapshotted)) {
    function files(node: Record<string, unknown>): void {
      if (node.type === "string" && node.format === "binary") {
        if (
          Object.keys(node).some(
            (key) =>
              ![
                "type",
                "format",
                "description",
                "title",
                "readOnly",
                "writeOnly",
                "deprecated",
              ].includes(key) && !key.startsWith("x-"),
          )
        )
          failImport(
            "unsupported_schema",
            path,
            "Binary file constraints cannot be discarded during artifact mapping",
          );
        delete node.format;
        node.type = "object";
        node.properties = { artifact_id: { type: "string", format: "uuid" } };
        node.required = ["artifact_id"];
        node.additionalProperties = false;
      } else {
        if (isJsonObject(node.properties))
          for (const child of Object.values(node.properties))
            if (isJsonObject(child)) files(child);
        if (isJsonObject(node.items)) files(node.items);
      }
    }
    files(snapshotted);
  }
  return snapshotted as JSONSchema;
}
function selectServer(
  root: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  source: OpenApiSource,
  path: string,
): string {
  const servers = operation.servers ?? pathItem.servers ?? root.servers;
  if (!Array.isArray(servers) || !servers.length)
    failImport(
      "unsupported_feature",
      path,
      "An explicit reviewed HTTPS server is required; no default server is inferred",
    );
  const candidates = servers.map((entry, index) =>
    object(entry, jsonPointer(path, index)),
  );
  let selected: string | undefined;
  for (const candidate of candidates) {
    if (typeof candidate.url !== "string")
      failImport("import_invalid", path, "Server URL must be a string");
    const raw = candidate.url as string;
    if (!raw.includes("{")) {
      if (
        source.serverUrl === raw ||
        (!source.serverUrl && candidates.every((other) => other.url === raw))
      )
        selected = raw;
      continue;
    }
    if (!source.serverUrl) continue;
    const variables = object(candidate.variables, path);
    const names: string[] = [];
    const escaped = raw
      .split(/(\{[^{}]+\})/)
      .map((part) => {
        if (/^\{[^{}]+\}$/.test(part)) {
          names.push(part.slice(1, -1));
          return "([^/?#]+)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    const match = new RegExp(`^${escaped}$`).exec(source.serverUrl);
    if (!match) continue;
    for (let index = 0; index < names.length; index++) {
      const variable = object(variables[names[index]!], path);
      const value = match[index + 1];
      if (
        !value ||
        hasCodeUnitInRange(value, 0, 32) ||
        value.includes("\\") ||
        value.includes("{") ||
        value.includes("}") ||
        (variable.enum !== undefined &&
          (!Array.isArray(variable.enum) || !variable.enum.includes(value)))
      )
        failImport(
          "import_invalid",
          path,
          "Explicit server variable value is invalid",
        );
    }
    selected = source.serverUrl;
  }
  if (!selected)
    failImport(
      "unsupported_feature",
      path,
      "Server selection is missing or does not match a declared server",
    );
  let parsed: URL;
  try {
    parsed = new URL(selected);
  } catch {
    return failImport("import_invalid", path, "Server URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    selected.includes("{") ||
    selected.includes("}") ||
    selected.includes("\\") ||
    hasCodeUnitInRange(selected, 0, 32) ||
    parsed.href.replace(/\/$/, "") !== selected.replace(/\/$/, "")
  )
    failImport(
      "import_invalid",
      path,
      "Server URL must be exact canonical HTTPS without credentials or variables",
    );
  return selected.replace(/\/$/, "");
}
function normalizeParameters(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  operationPath: string,
): { parameters: HttpParameter[]; origins: string[] } {
  const values = new Map<
    string,
    { parameter: Record<string, unknown>; path: string }
  >();
  for (const [scopeIndex, entries] of [
    pathItem.parameters,
    operation.parameters,
  ].entries()) {
    const sourcePath =
      scopeIndex === 0
        ? operationPath.slice(0, operationPath.lastIndexOf("/")) + "/parameters"
        : operationPath + "/parameters";
    if (entries === undefined) continue;
    if (!Array.isArray(entries))
      failImport("import_invalid", sourcePath, "Parameters must be an array");
    const scope = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const path = jsonPointer(sourcePath, index),
        parameter = object(entry, path);
      if (
        typeof parameter.name !== "string" ||
        typeof parameter.in !== "string"
      )
        failImport(
          "import_invalid",
          path,
          "Parameter name and location are required",
        );
      const key = `${parameter.in}:${parameter.in === "header" ? (parameter.name as string).toLowerCase() : parameter.name}`;
      if (scope.has(key))
        failImport(
          "import_invalid",
          path,
          "Duplicate parameter identities in the same scope",
        );
      scope.add(key);
      values.set(key, { parameter, path });
    }
  }
  const parameters: HttpParameter[] = [],
    origins: string[] = [];
  for (const { parameter, path } of values.values()) {
    if (
      !["path", "query", "header"].includes(parameter.in as string) ||
      parameter.allowReserved === true ||
      parameter.allowEmptyValue === true ||
      Object.hasOwn(parameter, "content")
    )
      failImport(
        "unsupported_feature",
        path,
        "Unsupported parameter location, content or escaping behavior",
      );
    for (const key of [
      "required",
      "explode",
      "allowReserved",
      "allowEmptyValue",
      "deprecated",
    ])
      if (parameter[key] !== undefined && typeof parameter[key] !== "boolean")
        failImport(
          "import_invalid",
          path,
          "Parameter boolean metadata is invalid",
        );
    const location = parameter.in as HttpParameter["in"];
    const style = location === "query" ? "form" : "simple";
    if ((parameter.style ?? style) !== style)
      failImport(
        "unsupported_feature",
        path,
        "Unsupported parameter serialization style",
      );
    if (location === "path" && parameter.required !== true)
      failImport(
        "import_invalid",
        path,
        "Path parameters must explicitly be required",
      );
    parameters.push({
      name: parameter.name as string,
      in: location,
      required: parameter.required === true,
      schema: schema(parameter.schema, path + "/schema"),
      style,
      explode:
        parameter.explode === undefined
          ? style === "form"
          : (parameter.explode as boolean),
    });
    origins.push(path);
  }
  return { parameters, origins };
}
function security(
  root: Record<string, unknown>,
  operation: Record<string, unknown>,
  source: OpenApiSource,
  key: string,
  path: string,
  context: OpenApiContext,
): Record<string, Requirement> {
  if (!Object.hasOwn(operation, "security")) path = "/security";
  const declarations = Object.hasOwn(operation, "security")
    ? operation.security
    : root.security;
  if (
    declarations === undefined ||
    (Array.isArray(declarations) && !declarations.length)
  )
    return Object.create(null);
  if (
    !Array.isArray(declarations) ||
    declarations.some((entry) => !isJsonObject(entry))
  )
    failImport(
      "import_invalid",
      path,
      "Security must be an array of scheme maps",
    );
  const selected = source.operationOptions[key]?.securityAlternative;
  if (declarations.length > 1 && selected === undefined)
    failImport(
      "unsupported_feature",
      path,
      "Multiple security alternatives require an explicit reviewed selection",
    );
  const index = selected ?? 0;
  if (index >= declarations.length)
    failImport(
      "import_invalid",
      path,
      "Selected security alternative does not exist",
    );
  const alternative = declarations[index] as Record<string, unknown>;
  const components =
    root.components === undefined ? {} : object(root.components, "/components");
  const schemes =
    components.securitySchemes === undefined
      ? {}
      : object(components.securitySchemes, "/components/securitySchemes");
  const requirements: Record<string, Requirement> = Object.create(null);
  const injectedHeaders = new Set<string>();
  for (const [schemeName, scopes] of Object.entries(alternative)) {
    const scheme = object(
      schemes[schemeName],
      jsonPointer("/components/securitySchemes", schemeName),
    );
    const mapping = source.securityMappings[schemeName];
    if (!mapping)
      failImport(
        "unsupported_feature",
        path,
        "Every selected security scheme requires an explicit trusted Provider mapping",
      );
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => typeof scope !== "string") ||
      new Set(scopes).size !== scopes.length
    )
      failImport(
        "import_invalid",
        path,
        "Security scopes must be unique strings",
      );
    let method: string;
    if (
      scheme.type === "http" &&
      typeof scheme.scheme === "string" &&
      ["bearer", "basic"].includes(scheme.scheme.toLowerCase())
    )
      method = scheme.scheme.toLowerCase();
    else if (
      scheme.type === "apiKey" &&
      scheme.in === "header" &&
      typeof scheme.name === "string" &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(scheme.name) &&
      !/^(?:host|cookie|connection|content-length|transfer-encoding|forwarded|x-forwarded-.*)$/i.test(
        scheme.name,
      )
    )
      method = "api_key";
    else if (scheme.type === "oauth2") {
      const flows = object(scheme.flows, path);
      if (
        Object.keys(flows).length !== 1 ||
        !isJsonObject(flows.authorizationCode)
      )
        failImport(
          "unsupported_feature",
          path,
          "Only trusted registered Provider authorization-code OAuth is supported",
        );
      const flow = flows.authorizationCode as Record<string, unknown>,
        declaredScopes = object(flow.scopes, path);
      if (
        typeof flow.authorizationUrl !== "string" ||
        typeof flow.tokenUrl !== "string" ||
        Object.values(declaredScopes).some(
          (description) => typeof description !== "string",
        ) ||
        scopes.some((scope) => !Object.hasOwn(declaredScopes, scope as string))
      )
        failImport(
          "import_invalid",
          path,
          "Authorization-code metadata and requested scope declarations are invalid",
        );
      for (const endpoint of [flow.authorizationUrl, flow.tokenUrl]) {
        let url: URL;
        try {
          url = new URL(endpoint as string);
        } catch {
          return failImport(
            "import_invalid",
            path,
            "OAuth metadata endpoints are invalid",
          );
        }
        if (url.protocol !== "https:" || url.username || url.password)
          failImport(
            "import_invalid",
            path,
            "OAuth metadata endpoints must use HTTPS without credentials",
          );
      }
      method = "oauth2";
    } else
      failImport(
        "unsupported_feature",
        path,
        "Unsupported authentication scheme or injection location",
      );
    if (method !== "oauth2" && scopes.length)
      failImport(
        "import_invalid",
        path,
        "Only OAuth schemes may declare scopes",
      );
    const mappedMethods = mapping.requirementDefinition.methods;
    if (
      method === "bearer"
        ? !mappedMethods.length ||
          mappedMethods.some(
            (entry) => entry !== "bearer" && entry !== "oauth2",
          )
        : mappedMethods.length !== 1 || mappedMethods[0] !== method
    )
      failImport(
        "unsupported_feature",
        path,
        "Provider mapping must explicitly select only Account methods with the declared authentication wire scheme",
      );
    const header = (
      scheme.type === "apiKey" ? (scheme.name as string) : "Authorization"
    ).toLowerCase();
    if (injectedHeaders.has(header))
      failImport(
        "unsupported_feature",
        path,
        "Selected AND security schemes collide on their authentication injection header",
      );
    injectedHeaders.add(header);
    if (Object.hasOwn(requirements, mapping.requirement))
      failImport(
        "unsupported_feature",
        path,
        "AND security schemes require distinct explicit Account requirements",
      );
    if (!context.validateSecurityMapping)
      failImport(
        "unsupported_feature",
        path,
        "Security mappings require a registered trusted Provider validator",
      );
    const requirement: Requirement = {
      ...mapping.requirementDefinition,
      scopes: [
        ...new Set([
          ...mapping.requirementDefinition.scopes,
          ...(scopes as string[]),
        ]),
      ].sort(),
    };
    try {
      context.validateSecurityMapping!(scheme, requirement);
    } catch {
      failImport(
        "unsupported_feature",
        path,
        "Security scheme does not match a registered trusted Provider",
      );
    }
    requirements[mapping.requirement] = requirement;
  }
  if (Object.keys(requirements).length > 8)
    failImport(
      "schema_limit",
      path,
      "A Tool may declare at most eight Account requirements",
    );
  return requirements;
}
function selectContent(
  value: unknown,
  selection: string | undefined,
  path: string,
  request: boolean,
  excluded: OpenApiResolution["manifest"]["excluded"],
): { mediaType: string; schema: JSONSchema } {
  const content = object(value, path);
  const candidates: string[] = [];
  for (const media of Object.keys(content)) {
    let kind: ReturnType<typeof mediaKind>;
    try {
      kind = mediaKind(media);
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      excluded.push({ path, mediaType: media });
      continue;
    }
    if (request ? kind !== "binary" : kind !== "form" && kind !== "multipart")
      candidates.push(media);
    else excluded.push({ path, mediaType: media });
  }
  if (!candidates.length)
    failImport(
      "unsupported_feature",
      path,
      "No supported reviewed media type is available",
    );
  if (candidates.length > 1 && !selection)
    failImport(
      "unsupported_feature",
      path,
      "Multiple media types require explicit reviewed selection",
    );
  const mediaType = selection ?? candidates[0]!;
  if (!candidates.includes(mediaType))
    failImport(
      "unsupported_feature",
      path,
      "Selected media type is not supported by this contract",
    );
  for (const media of candidates)
    if (media !== mediaType) excluded.push({ path, mediaType: media });
  const entry = object(content[mediaType], jsonPointer(path, mediaType));
  if (entry.encoding !== undefined) {
    const encoding = object(entry.encoding, path);
    for (const field of Object.values(encoding)) {
      const item = object(field, path);
      if (
        item.headers !== undefined ||
        item.contentType !== undefined ||
        (item.style !== undefined && item.style !== "form") ||
        (item.explode !== undefined && item.explode !== true) ||
        item.allowReserved === true
      )
        failImport(
          "unsupported_feature",
          path,
          "Custom form encoding or part headers are unsupported",
        );
    }
  }
  const kind = mediaKind(mediaType);
  if (!request && kind === "binary") {
    if (
      entry.schema !== undefined &&
      (!isJsonObject(entry.schema) ||
        entry.schema.type !== "string" ||
        entry.schema.format !== "binary" ||
        Object.keys(entry.schema).some(
          (key) =>
            !["type", "format", "description", "title"].includes(key) &&
            !key.startsWith("x-"),
        ))
    )
      failImport(
        "unsupported_schema",
        path,
        "Binary response schemas must be plain binary declarations without discarded constraints",
      );
    return {
      mediaType,
      schema: {
        type: "object",
        properties: { artifact: { type: "object" } },
        required: ["artifact"],
        additionalProperties: false,
      },
    };
  }
  return {
    mediaType,
    schema: schema(
      entry.schema ??
        (kind === "text"
          ? { type: "string" }
          : kind === "json"
            ? {}
            : undefined),
      jsonPointer(path, "schema"),
      kind === "multipart",
    ),
  };
}
function permission(
  url: string,
  method: HttpMethod,
  requirement: string | null,
): Permission {
  const parsed = new URL(url.replace(/\{[^{}]+\}/g, "m2_parameter"));
  const originalPath = url.slice(url.indexOf("/", "https://".length));
  const marker = originalPath.indexOf("{");
  if (marker < 0)
    return {
      requirement,
      origin: parsed.origin,
      methods: [method],
      path: parsed.pathname,
      match: "exact",
    };
  const parent =
    originalPath
      .slice(0, marker)
      .slice(0, originalPath.slice(0, marker).lastIndexOf("/")) || "/";
  return {
    requirement,
    origin: parsed.origin,
    methods: [method],
    path: parent,
    match: "prefix",
  };
}
/** Discovery is credential-free except explicitly approved reference fetches, never a business operation. */
export async function resolveOpenApiTools(
  source: OpenApiSource,
  context: OpenApiContext,
): Promise<OpenApiResolution> {
  const budget = createDerivedMetadataCounter();
  const resolved = await resolveReferences(source.document, {
    approvedOrigins: source.approvedRefOrigins,
    transport: context.transport,
    signal: context.signal,
    rootUrl: context.rootUrl,
  });
  const root = resolved.document;
  if (!/^3\.(?:0\.[0-3]|1\.[01])$/.test(String(root.openapi)))
    failImport(
      "import_invalid",
      "/openapi",
      "Only OpenAPI 3.0.0–3.0.3 and 3.1.0–3.1.1 are supported",
    );
  const dialect = (root.openapi as string).startsWith("3.0") ? "3.0" : "3.1";
  const info = object(root.info, "/info");
  if (typeof info.title !== "string" || typeof info.version !== "string")
    failImport(
      "import_invalid",
      "/info",
      "OpenAPI info requires a title and version",
    );
  if (
    root.jsonSchemaDialect !== undefined &&
    (dialect === "3.0" ||
      (root.jsonSchemaDialect !==
        "https://spec.openapis.org/oas/3.1/dialect/base" &&
        root.jsonSchemaDialect !==
          "https://json-schema.org/draft/2020-12/schema"))
  )
    failImport(
      "unsupported_schema",
      "/jsonSchemaDialect",
      "Unknown or incompatible OpenAPI schema dialect is unsupported",
    );
  const paths = object(root.paths, "/paths");
  // Security structure is document-authority input: malformed inheritance rejects the complete import.
  const components =
    root.components === undefined ? {} : object(root.components, "/components");
  const schemes =
    components.securitySchemes === undefined
      ? {}
      : object(components.securitySchemes, "/components/securitySchemes");
  for (const [name, scheme] of Object.entries(schemes))
    object(scheme, jsonPointer("/components/securitySchemes", name));
  function checkSecurity(value: unknown, path: string): void {
    if (value === undefined) return;
    if (
      !Array.isArray(value) ||
      value.some(
        (entry) =>
          !isJsonObject(entry) ||
          Object.entries(entry).some(
            ([name, scopes]) =>
              !Object.hasOwn(schemes, name) ||
              !Array.isArray(scopes) ||
              scopes.some((scope) => typeof scope !== "string") ||
              new Set(scopes).size !== scopes.length,
          ),
      )
    )
      failImport(
        "import_invalid",
        path,
        "Document security structure or scheme references are invalid",
      );
  }
  checkSecurity(root.security, "/security");
  let operationCount = 0;
  for (const [route, entry] of Object.entries(paths)) {
    if (route.startsWith("x-")) continue;
    if (
      !route.startsWith("/") ||
      route.includes("?") ||
      route.includes("#") ||
      route.includes("\\") ||
      hasCodeUnitInRange(route, 0, 32)
    )
      failImport(
        "import_invalid",
        jsonPointer("/paths", route),
        "OpenAPI path is invalid",
      );
    const pathItem = object(entry, jsonPointer("/paths", route));
    if (
      Object.keys(pathItem).some(
        (key) =>
          !Object.hasOwn(methods, key) &&
          !key.startsWith("x-") &&
          !["summary", "description", "servers", "parameters"].includes(key),
      )
    )
      failImport(
        "import_invalid",
        jsonPointer("/paths", route),
        "Path Item contains an unknown method or structural field",
      );
    for (const [method, operation] of Object.entries(pathItem))
      if (methods[method]) {
        operationCount++;
        const value = object(
          operation,
          jsonPointer(jsonPointer("/paths", route), method),
        );
        checkSecurity(
          value.security,
          jsonPointer(
            jsonPointer(jsonPointer("/paths", route), method),
            "security",
          ),
        );
      }
  }
  if (operationCount > 500)
    failImport(
      "reference_limit",
      "/paths",
      "OpenAPI exceeds 500 operations including unsupported methods",
    );
  const accepted: ToolDefinition[] = [],
    rejected: ReviewRejected[] = [],
    warnings: SourceWarning[] = [],
    diagnostics: ReviewDiagnostic[] = [],
    excluded: OpenApiResolution["manifest"]["excluded"] = [],
    names = new Set<string>(),
    identifiers = new Set<string>();
  const schemaNodes = new Set<object>();
  for (const [route, entry] of Object.entries(paths)) {
    if (route.startsWith("x-")) continue;
    const pathItem = entry as Record<string, unknown>;
    for (const [method, value] of Object.entries(pathItem)) {
      if (!methods[method]) continue;
      const operation = value as Record<string, unknown>,
        operationPath = jsonPointer(jsonPointer("/paths", route), method);
      const upstreamName =
        typeof operation.operationId === "string" && operation.operationId
          ? operation.operationId
          : `${method.toUpperCase()} ${route}`;
      if (identifiers.has(upstreamName))
        failImport(
          "name_collision",
          operationPath,
          "Operation identifiers are duplicated; explicit unique identifiers are required",
        );
      identifiers.add(upstreamName);
      const excludedStart = excluded.length;
      let sourcePointer = (path: string): string =>
        path.startsWith("/paths/") ||
        path.startsWith("/components/") ||
        path === "/security"
          ? path
          : operationPath;
      try {
        if (!supported[method])
          failImport(
            "unsupported_feature",
            operationPath,
            "Unsupported HTTP method",
          );
        if (operation.callbacks !== undefined)
          failImport(
            "unsupported_feature",
            operationPath,
            "OpenAPI callbacks are unsupported",
          );
        const name =
          source.nameMapping[upstreamName] ?? `${context.slug}.${upstreamName}`;
        if (
          !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(name) ||
          name.length > 128 ||
          !name.startsWith(`${context.slug}.`) ||
          name.startsWith("runs.")
        )
          failImport(
            "unsupported_feature",
            operationPath,
            "Operation requires an explicit canonical Tool name mapping",
          );
        if (names.has(name))
          failImport(
            "name_collision",
            operationPath,
            "Tool names collide; review explicit name mappings",
          );
        names.add(name);
        const serverPath = Object.hasOwn(operation, "servers")
          ? operationPath + "/servers"
          : Object.hasOwn(pathItem, "servers")
            ? operationPath.slice(0, operationPath.lastIndexOf("/")) +
              "/servers"
            : "/servers";
        const server = selectServer(
            root,
            pathItem,
            operation,
            source,
            serverPath,
          ),
          url = server + route;
        const { parameters, origins } = normalizeParameters(
          pathItem,
          operation,
          operationPath,
        );
        const requirements = security(
            root,
            operation,
            source,
            upstreamName,
            Object.hasOwn(operation, "security")
              ? operationPath + "/security"
              : "/security",
            context,
          ),
          options = source.operationOptions[upstreamName];
        let requestBody: HttpImplementation["requestBody"];
        if (operation.requestBody !== undefined) {
          const body = object(
            operation.requestBody,
            `${operationPath}/requestBody`,
          );
          if (body.required !== undefined && typeof body.required !== "boolean")
            failImport(
              "import_invalid",
              `${operationPath}/requestBody`,
              "Request body required must be boolean",
            );
          const selected = selectContent(
            body.content,
            options?.requestMediaType,
            `${operationPath}/requestBody/content`,
            true,
            excluded,
          );
          requestBody = { ...selected, required: body.required === true };
        }
        const responses = object(
            operation.responses,
            `${operationPath}/responses`,
          ),
          statuses: NonNullable<HttpImplementation["response"]["statuses"]> =
            Object.create(null);
        for (const [status, responseValue] of Object.entries(responses)) {
          if (status.startsWith("x-")) continue;
          if (status !== "default" && !/^[1-5][0-9]{2}$/.test(status))
            failImport(
              "unsupported_feature",
              `${operationPath}/responses`,
              "Response status ranges and nonexact codes are unsupported",
            );
          const response = object(
            responseValue,
            `${operationPath}/responses/${status}`,
          );
          if (
            response.content === undefined &&
            (method === "head" || status === "204")
          ) {
            statuses[status] = { mediaType: "text/plain" };
            continue;
          }
          const selected = selectContent(
            response.content,
            options?.responseMediaType,
            `${operationPath}/responses/${status}/content`,
            false,
            excluded,
          );
          statuses[status] =
            mediaKind(selected.mediaType) === "binary"
              ? { mediaType: selected.mediaType }
              : selected;
        }
        const success =
          Object.keys(statuses).find((status) => /^2/.test(status)) ??
          (Object.hasOwn(statuses, "default") ? "default" : undefined);
        if (!success)
          failImport(
            "unsupported_feature",
            `${operationPath}/responses`,
            "A reviewed success or default response contract is required",
          );
        const implementation: HttpImplementation = {
          kind: "http",
          dialect,
          method: method.toUpperCase() as HttpMethod,
          url,
          parameters,
          ...(requestBody ? { requestBody } : {}),
          response: { ...statuses[success]!, statuses },
        };
        sourcePointer = (path: string): string => {
          const parameter = /^\/implementation\/parameters\/(\d+)(.*)$/.exec(
            path,
          );
          const origin = parameter ? origins[Number(parameter[1]!)] : undefined;
          if (parameter && origin) return origin + parameter[2]!;
          if (
            path.startsWith("/implementation/requestBody/schema") &&
            requestBody
          )
            return (
              `${operationPath}/requestBody/content/${requestBody.mediaType.replaceAll("~", "~0").replaceAll("/", "~1")}/schema` +
              path.slice("/implementation/requestBody/schema".length)
            );
          const response =
            /^\/implementation\/response\/statuses\/([^/]+)\/schema(.*)$/.exec(
              path,
            );
          const contract = response ? statuses[response[1]!] : undefined;
          if (response && contract)
            return (
              `${operationPath}/responses/${response[1]!}/content/${contract.mediaType.replaceAll("~", "~0").replaceAll("/", "~1")}/schema` +
              response[2]!
            );
          return path.startsWith("/paths/") ||
            path.startsWith("/components/") ||
            path === "/security" ||
            path === "/servers"
            ? path
            : operationPath;
        };
        const tool: ToolDefinition = {
          name,
          upstreamName,
          description:
            typeof operation.description === "string"
              ? operation.description
              : typeof operation.summary === "string"
                ? operation.summary
                : "",
          inputSchema: httpInputSchema(implementation),
          operationClass: "unknown",
          requirements,
          permissions: (Object.keys(requirements).length
            ? Object.keys(requirements)
            : [null]
          ).map((requirement) =>
            permission(url, implementation.method, requirement),
          ),
          implementation,
        };
        const normalized = normalizeHttpTool(tool);
        // The imported definition already uses the exact generated wrapper; avoid duplicating its constraints/composition depth.
        normalized.tool.inputSchema = tool.inputSchema;
        for (const node of [
          normalized.tool.inputSchema,
          normalized.tool.outputSchema,
          ...Object.values(statuses).map((contract) => contract.schema),
        ])
          if (node !== undefined) {
            const problem = schemaStructureProblem(node, schemaNodes);
            if (problem)
              failImport(
                "schema_limit",
                operationPath,
                "Aggregate schema budget exceeded",
              );
          }
        budget.add(normalized.tool);
        accepted.push(normalized.tool);
        for (const warning of normalized.warnings)
          if (!warning.path.startsWith("/inputSchema")) {
            const path = sourcePointer(warning.path),
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
        for (const exclusion of excluded.slice(excludedStart)) {
          const diagnostic: ReviewDiagnostic = {
            upstreamName,
            path: jsonPointer(exclusion.path, exclusion.mediaType),
            code: "excluded_media",
            message:
              "This media alternative was excluded from the accepted operation's reviewed request or response contract.",
          };
          budget.add(diagnostic);
          diagnostics.push(diagnostic);
        }
      } catch (error) {
        if (!(error instanceof ImportError)) throw error;
        if (
          [
            "reference_limit",
            "reference_forbidden",
            "schema_limit",
            "name_collision",
          ].includes(error.code)
        )
          throw error;
        const rejection: ReviewRejected = {
          upstreamName,
          path: sourcePointer(error.path),
          code: error.code,
          message: error.message,
        };
        budget.add(rejection);
        rejected.push(rejection);
      }
    }
  }
  return {
    accepted,
    rejected,
    warnings,
    diagnostics,
    manifest: {
      documents: resolved.documents,
      references: resolved.references,
      excluded,
    },
  };
}
