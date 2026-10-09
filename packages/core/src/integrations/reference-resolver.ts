import {
  hasCodeUnitInRange,
  isJsonObject,
  type JSONValue,
  jsonProblem,
  M2_LIMITS,
} from "@scaffold/schema/integrations";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { parseStrictJson } from "../strict-json.js";
import type { HttpTransport } from "./transport.js";

export class ImportError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}
export function failImport(code: string, path: string, message: string): never {
  throw new ImportError(code, path, message);
}
export const jsonPointer = (path: string, key: string | number) =>
  `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const referenceIssues = new WeakMap<object, string>();
export function referenceSchemaProblem(node: object): string | undefined {
  return referenceIssues.get(node);
}
export function parseSourceDocument(source: string): JSONValue {
  if (new TextEncoder().encode(source).length > M2_LIMITS.documentBytes)
    failImport("reference_limit", "", "Document exceeds 5 MiB");
  let value: unknown;
  try {
    if (/^\s*[[{]/.test(source)) {
      try {
        value = parseStrictJson(source, 128);
      } catch {
        value = undefined;
      }
    }
    if (value === undefined) {
      if (/^%TAG(?:\s|$)/m.test(source)) throw new Error();
      const doc = parseDocument(source, {
        schema: "core",
        uniqueKeys: true,
        merge: false,
        strict: true,
      });
      if (doc.errors.length || doc.warnings.length) throw new Error();
      function inspect(node: unknown, depth: number): void {
        if (depth > 128 || isAlias(node)) throw new Error();
        if (isMap(node) || isSeq(node) || isScalar(node)) {
          if (node.tag || node.anchor) throw new Error();
          if (isMap(node))
            for (const pair of node.items) {
              if (
                !isScalar(pair.key) ||
                typeof pair.key.value !== "string" ||
                pair.key.value === "<<"
              )
                throw new Error();
              inspect(pair.key, depth + 1);
              inspect(pair.value, depth + 1);
            }
          else if (isSeq(node))
            for (const child of node.items) inspect(child, depth + 1);
        }
      }
      inspect(doc.contents, 0);
      value = doc.toJS({ maxAliasCount: 0 });
    }
    if (jsonProblem(value, M2_LIMITS.documentBytes)) throw new Error();
  } catch {
    failImport(
      "import_invalid",
      "",
      "Document must be strict JSON or safe JSON-compatible YAML without duplicate keys, tags, aliases or merge keys",
    );
  }
  return value as JSONValue;
}
export async function readBounded(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      throw new ImportError(
        "execution_timeout",
        "",
        "The bounded response deadline elapsed",
      );
    }
    for (;;) {
      const next = await reader.read();
      if (signal?.aborted)
        throw new ImportError(
          "execution_timeout",
          "",
          "The bounded response deadline elapsed",
        );
      if (next.done) break;
      total += next.value.length;
      if (total > limit) {
        await reader.cancel();
        throw new ImportError(
          "payload_too_large",
          "",
          "Response exceeds its reviewed size limit",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export interface ReferenceDocument {
  url: string;
  finalUrl: string;
  source: string;
  sha256: string;
}
export interface ResolvedReferences {
  document: Record<string, unknown>;
  documents: ReferenceDocument[];
  references: { path: string; target: string }[];
}
export interface ReferenceOptions {
  transport?: HttpTransport;
  approvedOrigins: readonly string[];
  rootUrl?: string;
  signal?: AbortSignal;
}
const ROOT = "https://mcpone.invalid/__openapi_root__";
function safeUrl(raw: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return failImport("reference_forbidden", "", "Reference URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    hasCodeUnitInRange(raw, 0, 32) ||
    raw.includes("\\")
  )
    failImport(
      "reference_forbidden",
      "",
      "References require a canonical HTTPS URL without credentials",
    );
  return url;
}
function targetAt(document: unknown, hash: string): unknown {
  if (!hash) return document;
  let decoded: string;
  try {
    decoded = decodeURIComponent(hash.slice(1));
  } catch {
    return failImport("import_invalid", "", "Invalid reference fragment");
  }
  if (!decoded.startsWith("/"))
    failImport(
      "import_invalid",
      "",
      "Only JSON Pointer reference fragments are supported",
    );
  let node = document;
  for (const token of decoded.slice(1).split("/")) {
    if (/~(?![01])/.test(token))
      failImport("import_invalid", "", "Invalid JSON Pointer escape");
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key))
      failImport("import_invalid", "", "Reference target does not exist");
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
async function digest(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
/** Credential-free immutable graph resolution. All network safety is supplied by the pinned transport, never fetch. */
export async function resolveReferences(
  source: string,
  options: ReferenceOptions,
): Promise<ResolvedReferences> {
  const totalSignal = AbortSignal.any([
    AbortSignal.timeout(30000),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (totalSignal.aborted)
    failImport("reference_limit", "", "Reference resolution deadline elapsed");
  const root = parseSourceDocument(source);
  if (!isJsonObject(root))
    failImport("import_invalid", "", "OpenAPI root must be an object");
  if (
    typeof root.openapi !== "string" ||
    !/^3\.(?:0\.[0-3]|1\.[01])$/.test(root.openapi)
  )
    failImport(
      "import_invalid",
      "/openapi",
      "Only OpenAPI 3.0.0–3.0.3 and 3.1.0–3.1.1 are supported",
    );
  const rootUrl = safeUrl(options.rootUrl ?? ROOT);
  rootUrl.hash = "";
  const documents: ReferenceDocument[] = [
    {
      url: rootUrl.href,
      finalUrl: rootUrl.href,
      source,
      sha256: await digest(source),
    },
  ];
  const parsed = new Map<string, { value: unknown; base: string }>([
    [rootUrl.href, { value: root, base: rootUrl.href }],
  ]);
  let aggregate = new TextEncoder().encode(source).length,
    count = 0;
  const countedReferences = new WeakSet<object>();
  const references: ResolvedReferences["references"] = [];
  function approved(url: URL): void {
    if (!options.approvedOrigins.includes(url.origin))
      failImport(
        "reference_forbidden",
        "",
        "Reference origin is not explicitly approved",
      );
  }
  async function document(url: URL): Promise<{ value: unknown; base: string }> {
    const key = url.href;
    const known = parsed.get(key);
    if (known) return known;
    approved(url);
    if (!options.transport)
      failImport(
        "reference_forbidden",
        "",
        "A pinned reference transport is required",
      );
    if (documents.length >= 16)
      failImport(
        "reference_limit",
        "",
        "At most sixteen reference documents are allowed",
      );
    let current = url;
    let response: Response | undefined;
    let attemptSignal = totalSignal;
    for (let redirects = 0; ; redirects++) {
      approved(current);
      if (totalSignal.aborted)
        failImport(
          "reference_limit",
          "",
          "Reference resolution deadline elapsed",
        );
      const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(10000)]);
      attemptSignal = signal;
      try {
        response = await options.transport.request({
          url: current.href,
          method: "GET",
          headers: new Headers({
            Accept: "application/json, application/yaml, text/yaml",
            "Accept-Encoding": "identity",
          }),
          signal,
          maxResponseBytes: M2_LIMITS.documentBytes,
        });
      } catch (error) {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        failImport(
          code === "unsafe_target" || code === "unsupported_destination"
            ? "reference_forbidden"
            : code === "response_too_large" || signal.aborted
              ? "reference_limit"
              : "import_invalid",
          "",
          "Approved reference retrieval failed within its transport limits",
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 3)
        failImport(
          "reference_limit",
          "",
          "At most three reference redirects are allowed",
        );
      const location = response.headers.get("location");
      if (!location)
        failImport(
          "import_invalid",
          "",
          "Reference redirect has no destination",
        );
      current = safeUrl(location, current.href);
      if (current.hash)
        failImport(
          "reference_forbidden",
          "",
          "Reference redirect fragments are unsupported",
        );
    }
    if (!response.ok) {
      await response.body?.cancel();
      failImport("import_invalid", "", "Reference retrieval failed");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readBounded(response, M2_LIMITS.documentBytes, attemptSignal),
      );
    } catch (error) {
      return failImport(
        error instanceof ImportError &&
          ["payload_too_large", "execution_timeout"].includes(error.code)
          ? "reference_limit"
          : "import_invalid",
        "",
        "Reference document is not bounded UTF-8 within its deadline",
      );
    }
    aggregate += new TextEncoder().encode(text).length;
    if (aggregate > 20 * 1048576)
      failImport("reference_limit", "", "Reference graph exceeds 20 MiB");
    const result = { value: parseSourceDocument(text), base: current.href };
    parsed.set(key, result);
    parsed.set(current.href, result);
    documents.push({
      url: key,
      finalUrl: current.href,
      source: text,
      sha256: await digest(text),
    });
    return result;
  }
  const dialect30 =
    typeof root.openapi === "string" && root.openapi.startsWith("3.0.");
  const expanded = new WeakMap<
    object,
    { value: unknown; dereferences: number; nesting: number }
  >();
  let expansionVisits = 0;
  async function expand(
    node: unknown,
    base: string,
    path: string,
    chain: readonly string[],
    depth: number,
  ): Promise<unknown> {
    if (++expansionVisits % 1024 === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (totalSignal.aborted)
      failImport(
        "reference_limit",
        path,
        "Reference resolution deadline elapsed",
      );
    if (depth > 128)
      failImport(
        "reference_limit",
        path,
        "Resolved document nesting exceeds its limit",
      );
    if (!Array.isArray(node) && !isJsonObject(node)) return node;
    const cached = expanded.get(node);
    if (cached) {
      if (
        chain.length + cached.dereferences > 10 ||
        depth + cached.nesting > 128
      )
        failImport(
          "reference_limit",
          path,
          "Reference dereference or document nesting limit exceeded",
        );
      return cached.value;
    }
    let dereferences = 0,
      nesting = 0;
    function remember(value: unknown): unknown {
      if (chain.length + dereferences > 10 || depth + nesting > 128)
        failImport(
          "reference_limit",
          path,
          "Reference dereference or document nesting limit exceeded",
        );
      expanded.set(node as object, { value, dereferences, nesting });
      return value;
    }
    function childLimits(child: unknown, ref = false): void {
      const previous =
        child !== null && typeof child === "object"
          ? expanded.get(child)
          : undefined;
      dereferences = Math.max(
        dereferences,
        (previous?.dereferences ?? 0) + (ref ? 1 : 0),
      );
      nesting = Math.max(nesting, (previous?.nesting ?? 0) + 1);
    }
    if (Array.isArray(node)) {
      const result = [];
      for (let index = 0; index < node.length; index++) {
        result.push(
          await expand(
            node[index],
            base,
            jsonPointer(path, index),
            chain,
            depth + 1,
          ),
        );
        childLimits(node[index]);
      }
      return remember(result);
    }
    const result: Record<string, unknown> = Object.create(null);
    if (Object.hasOwn(node, "$ref")) {
      if (typeof node.$ref !== "string")
        failImport("import_invalid", path, "Reference must be a string");
      if (!countedReferences.has(node)) {
        countedReferences.add(node);
        count++;
      }
      if (count > 1000 || chain.length >= 10)
        failImport(
          "reference_limit",
          path,
          "Reference count or dereference depth exceeds its limit",
        );
      const url = safeUrl(node.$ref as string, base);
      const target = url.href;
      if (chain.includes(target))
        failImport("import_invalid", path, "Cyclic references are unsupported");
      url.hash = "";
      const doc = await document(url);
      const value = targetAt(doc.value, new URL(target).hash);
      references.push({ path, target });
      const resolved = await expand(
        value,
        doc.base,
        path,
        [...chain, target],
        depth + 1,
      );
      childLimits(value, true);
      const siblings = Object.keys(node).filter((key) => key !== "$ref");
      if (!siblings.length) return remember(resolved);
      const invalid30 =
        dialect30 &&
        siblings.some(
          (k) =>
            ![
              "title",
              "description",
              "summary",
              "deprecated",
              "example",
              "examples",
              "default",
            ].includes(k) && !k.startsWith("x-"),
        );
      const schemaReference =
        /(?:\/schema(?:\/|$)|\/schemas\/)/.test(path) ||
        siblings.some((key) =>
          [
            "type",
            "properties",
            "items",
            "allOf",
            "oneOf",
            "anyOf",
            "minimum",
            "maximum",
            "enum",
          ].includes(key),
        );
      if (!dialect30 && schemaReference) {
        const siblingSchema: Record<string, unknown> = Object.create(null);
        for (const key of siblings) {
          const annotation =
            key.startsWith("x-") ||
            ["example", "examples", "default", "enum", "const"].includes(key);
          siblingSchema[key] = annotation
            ? node[key]
            : await expand(
                node[key],
                base,
                jsonPointer(path, key),
                chain,
                depth + 1,
              );
          if (!annotation) childLimits(node[key]);
        }
        if (!isJsonObject(resolved) && typeof resolved !== "boolean")
          failImport(
            "import_invalid",
            path,
            "Schema reference target must be a schema",
          );
        const conjunctive: Record<string, unknown> = {
          allOf: [resolved, siblingSchema],
        };
        // Explicit serialization shape is redundant with, never a replacement for, both original constraints.
        if (isJsonObject(resolved))
          for (const key of [
            "type",
            "properties",
            "items",
            "additionalProperties",
          ])
            if (Object.hasOwn(resolved, key)) conjunctive[key] = resolved[key];
        return remember(conjunctive);
      }
      if (!isJsonObject(resolved))
        failImport(
          "import_invalid",
          path,
          "Reference siblings require an object target",
        );
      Object.assign(result, resolved);
      if (invalid30)
        referenceIssues.set(
          result,
          "OpenAPI 3.0 reference validation siblings are unsupported",
        );
    }
    const namedContainer =
      /\/(?:properties|\$defs|schemas|responses|paths|securitySchemes|headers|content)$/.test(
        path,
      );
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") continue;
      const annotation =
        !namedContainer &&
        (key.startsWith("x-") ||
          ["example", "examples", "default", "enum", "const"].includes(key));
      result[key] = annotation
        ? value
        : await expand(value, base, jsonPointer(path, key), chain, depth + 1);
      if (!annotation) childLimits(value);
    }
    if (
      isJsonObject(node.discriminator) &&
      isJsonObject(node.discriminator.mapping)
    ) {
      const branches = node.oneOf ?? node.anyOf;
      if (Array.isArray(branches)) {
        const mapping: Record<string, unknown> = Object.create(null);
        for (const [tag, reference] of Object.entries(
          node.discriminator.mapping,
        )) {
          if (typeof reference !== "string") {
            referenceIssues.set(
              result,
              "Discriminator mapping must use explicit references",
            );
            continue;
          }
          const target = safeUrl(reference as string, base);
          const docUrl = new URL(target);
          docUrl.hash = "";
          const doc = await document(docUrl);
          const mapped = targetAt(doc.value, target.hash);
          const index = branches.findIndex(
            (branch) =>
              branch === mapped ||
              (isJsonObject(branch) &&
                typeof branch.$ref === "string" &&
                safeUrl(branch.$ref, base).href === target.href),
          );
          if (index < 0) {
            referenceIssues.set(
              result,
              "Discriminator mapping must resolve to an exact branch",
            );
            continue;
          }
          mapping[tag] = `$m2branch:${index}`;
        }
        (result.discriminator as Record<string, unknown>).mapping = mapping;
      }
    }
    return remember(result);
  }
  return {
    document: (await expand(root, rootUrl.href, "", [], 0)) as Record<
      string,
      unknown
    >,
    documents,
    references,
  };
}
/** Rebase verified discriminator pointers into the independently validated schema snapshot. */
export function snapshotSchema(node: unknown, path = ""): unknown {
  if (Array.isArray(node))
    return node.map((value, index) =>
      snapshotSchema(value, jsonPointer(path, index)),
    );
  if (!isJsonObject(node)) return node;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(node))
    result[key] = snapshotSchema(value, jsonPointer(path, key));
  if (
    isJsonObject(result.discriminator) &&
    isJsonObject(result.discriminator.mapping)
  )
    for (const [tag, ref] of Object.entries(result.discriminator.mapping)) {
      if (typeof ref === "string" && /^\$m2branch:\d+$/.test(ref))
        result.discriminator.mapping[tag] =
          `#${jsonPointer(jsonPointer(path, Object.hasOwn(result, "oneOf") ? "oneOf" : "anyOf"), Number(ref.slice(10)))}`;
    }
  return result;
}
