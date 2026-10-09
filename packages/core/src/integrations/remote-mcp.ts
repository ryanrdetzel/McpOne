import { ExecutionErrorCode } from "@scaffold/schema/execution";
import {
  type BusinessMcpResult,
  BusinessMcpResult as BusinessResultSchema,
  type EffectEvidence,
  EffectEvidence as EffectSchema,
  type FrozenTool,
  type HttpMethod,
  hasCodeUnitInRange,
  isJsonObject,
  type JSONValue,
  jsonProblem,
  type RemoteMcpSource,
  type Requirement,
  type ReviewRejected,
  Source as SourceSchema,
  schemaStructureProblem,
  type ToolDefinition,
  ToolDefinition as ToolSchema,
} from "@scaffold/schema/integrations";
import { canonicalJson, sha256 } from "../execution/canonical.js";
import { parseStrictJson } from "../strict-json.js";
import {
  createDerivedMetadataCounter,
  DerivedMetadataBudgetError,
} from "./derived-budget.js";
import { validateInput, validateSchema } from "./schema.js";
import type { HttpTransport } from "./transport.js";

export const REMOTE_MCP_PROTOCOL_VERSION = "2025-06-18" as const;
export const REMOTE_IMPLEMENTATION_LIMITATION =
  "The reviewed remote manifest is immutable local configuration, not a pinned remote executable. An unversioned server may change behavior behind the same endpoint; rollback cannot restore its implementation or undo effects.";
const JSON_BYTES = 1_048_576;
const MANIFEST_BYTES = 5_242_880;
const FRAME_BYTES = JSON_BYTES + 65_536;
const EXECUTION_NAMESPACE = "com.toolcontrolplane/execution";
const encoder = new TextEncoder();
const own = (value: object, key: string) => Object.hasOwn(value, key);

export type RemoteOwnerContext = {
  orgId: string;
  userId: string;
  slug: string;
};
export type RemoteAuthentication = {
  requirement: string;
  definition: Requirement;
};
export type RemoteDiscoveryTransport = HttpTransport & {
  redact?: (text: string) => string;
};
export type RemoteRawRequest = {
  accountRequirement: string | null;
  method: HttpMethod;
  url: string;
  headers?: Headers | Record<string, string>;
  body?: Uint8Array;
  mediaType?: string;
  maxResponseBytes?: number;
  trustedHeaders?: Record<string, string>;
  controlTraffic?: boolean;
};
/** Trusted adapter capability only: never expose this interface to a guest or caller. */
export type RemoteBroker = {
  requestRaw(input: RemoteRawRequest): Promise<Response>;
  redact?(text: string): string;
  effect?(): EffectEvidence;
};
export type RemoteMcpDependencies = {
  transport: HttpTransport;
  discoveryTransport?: (
    owner: RemoteOwnerContext,
    accountId: string,
    endpoint: string,
  ) => Promise<RemoteDiscoveryTransport>;
  connectionTransport?: (
    owner: RemoteOwnerContext,
    credentialId: string,
    endpoint: string,
  ) => Promise<RemoteDiscoveryTransport>;
  describeAuthentication?: (
    owner: RemoteOwnerContext,
    accountId: string | undefined,
    endpoint: string,
  ) => Promise<RemoteAuthentication | null>;
  /** Independent trusted Provider guarantees only; never use server annotations as retry evidence. */
  effectEvidence?: (
    tool: ToolDefinition,
    response: Response,
    result?: BusinessMcpResult,
  ) => EffectEvidence;
};
export type RemoteManifestSnapshot = {
  endpoint: string;
  protocolVersion: typeof REMOTE_MCP_PROTOCOL_VERSION;
  sessionRequired: boolean;
  manifest: Record<string, JSONValue>[];
  manifestDigest: string;
  implementationPinned: false;
  limitation: string;
};
export type RemoteResolution = {
  accepted: ToolDefinition[];
  rejected: ReviewRejected[];
  snapshot: RemoteManifestSnapshot;
};
export type RemoteInvocation = {
  runId: string;
  claimId: string;
  tool: FrozenTool;
  arguments: Record<string, JSONValue>;
  deadlineMs: number;
  broker: RemoteBroker;
};

/** Safe static diagnostics; raw upstream bodies, session IDs and platform exceptions stay private. */
export class RemoteMcpError extends Error {
  readonly retryable = false;
  constructor(
    readonly code: string,
    message: string,
    readonly effect: EffectEvidence = { state: "not_dispatched" },
  ) {
    super(message);
    this.name = "RemoteMcpError";
  }
}
function fail(code: string, message: string): never {
  throw new RemoteMcpError(code, message);
}
function endpointUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    fail("invalid_request", "Review a canonical HTTPS remote endpoint.");
  }
  if (
    url!.protocol !== "https:" ||
    url!.username ||
    url!.password ||
    url!.hash ||
    url!.port ||
    hasCodeUnitInRange(endpoint, 0, 32) ||
    endpoint.includes("\\") ||
    url!.href !== endpoint ||
    /%(?:2f|5c|00)/i.test(url!.pathname) ||
    /%(?![a-f0-9]{2})/i.test(url!.pathname)
  )
    fail("invalid_request", "Review a canonical HTTPS remote endpoint.");
  return url!;
}
function strictObject(source: string): Record<string, unknown> {
  let value: unknown;
  // RPC envelopes and schema-property containers are deeper than the business value they carry.
  // Business results still pass the unchanged depth-64 preflight in normalizeResult.
  try {
    value = parseStrictJson(source, 128);
  } catch {
    fail("unsupported_result", "The remote returned malformed JSON.");
  }
  if (!isJsonObject(value) || jsonProblem(value, JSON_BYTES, 128))
    fail(
      "unsupported_result",
      "The remote returned invalid or over-limit JSON.",
    );
  return value;
}
function timeoutError(): RemoteMcpError {
  return new RemoteMcpError(
    "execution_timeout",
    "The remote request exceeded its bounded deadline.",
  );
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(timeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timeoutError());
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function clock(deadlineMs: number): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const duration = Math.max(0, deadlineMs - Date.now());
  if (duration === 0) controller.abort();
  const timer = setTimeout(() => controller.abort(), duration);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}
async function cancel(response: Response): Promise<void> {
  void response.body?.cancel().catch(() => undefined);
}
function decodedEncoding(response: Response): void {
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity")
    fail(
      "unsupported_result",
      "The transport did not establish bounded decoded response semantics.",
    );
}
async function collect(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  decodedEncoding(response);
  if (!response.body)
    fail("unsupported_result", "The remote response body is missing.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    source = "";
  try {
    for (;;) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit)
        fail(
          "payload_too_large",
          "The remote response exceeded its byte limit.",
        );
      source += decoder.decode(part.value, { stream: true });
    }
    return source + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof RemoteMcpError) throw error;
    fail(
      "unsupported_result",
      "The remote response could not be decoded as bounded UTF-8.",
    );
  } finally {
    reader.releaseLock();
  }
}

type Request = (input: {
  method: "POST" | "DELETE";
  body?: Uint8Array;
  headers: Headers;
  trustedHeaders: Record<string, string>;
  controlTraffic: boolean;
  signal: AbortSignal;
}) => Promise<Response>;
type RpcEnvelope = Record<string, unknown>;
class Session {
  private id: string | undefined;
  private negotiated = false;
  private sequence = 0;
  readonly prefix = crypto.randomUUID();
  get required(): boolean {
    return this.id !== undefined;
  }
  redact(text: string): string {
    return this.id ? text.split(this.id).join("[redacted]") : text;
  }
  constructor(
    readonly endpoint: string,
    readonly request: Request,
    readonly signal: AbortSignal,
  ) {}
  private headers(): {
    headers: Headers;
    trustedHeaders: Record<string, string>;
  } {
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "accept-encoding": "identity",
    });
    const trustedHeaders: Record<string, string> = {};
    if (this.negotiated)
      trustedHeaders["mcp-protocol-version"] = REMOTE_MCP_PROTOCOL_VERSION;
    if (this.id !== undefined) trustedHeaders["mcp-session-id"] = this.id;
    return { headers, trustedHeaders };
  }
  private async send(
    envelope: RpcEnvelope,
    controlTraffic: boolean,
  ): Promise<Response> {
    if (this.signal.aborted) throw timeoutError();
    const body = encoder.encode(JSON.stringify(envelope));
    if (body.byteLength > JSON_BYTES)
      fail(
        "payload_too_large",
        "The complete outbound MCP request exceeds one MiB.",
      );
    const { headers, trustedHeaders } = this.headers();
    headers.set("content-type", "application/json");
    const pending = this.request({
      method: "POST",
      body,
      headers,
      trustedHeaders,
      controlTraffic,
      signal: this.signal,
    });
    // A transport completing after the deadline must not leave its body/socket retained.
    void pending.then(
      (response) => {
        if (this.signal.aborted) void cancel(response);
      },
      () => undefined,
    );
    const response = await bounded(pending, this.signal);
    if (response.status < 200 || response.status >= 300) {
      void cancel(response);
      fail(
        response.status === 404 && this.id !== undefined
          ? "tool_unavailable"
          : "upstream_rejected",
        "The remote rejected this protocol request; inspect the recorded Run before invoking again.",
      );
    }
    const protocol = response.headers.get("mcp-protocol-version");
    if (protocol !== null && protocol !== REMOTE_MCP_PROTOCOL_VERSION) {
      void cancel(response);
      fail(
        "unsupported_protocol",
        "The remote selected an unsupported MCP version.",
      );
    }
    const session = response.headers.get("mcp-session-id");
    if (session !== null) {
      if (
        !/^[\x21-\x7e]{1,1024}$/.test(session) ||
        (this.id !== undefined && session !== this.id)
      ) {
        void cancel(response);
        fail(
          "unsupported_protocol",
          "The remote returned an invalid or changed session identifier.",
        );
      }
      if (this.id === undefined && !this.negotiated) this.id = session;
      else if (this.id === undefined) {
        void cancel(response);
        fail(
          "unsupported_protocol",
          "The remote introduced a session outside initialization.",
        );
      }
    }
    return response;
  }
  private async empty(response: Response): Promise<void> {
    if (response.status !== 202 && response.status !== 204) {
      void cancel(response);
      fail(
        "unsupported_protocol",
        "The remote did not acknowledge a protocol notification.",
      );
    }
    if (response.body) {
      const body = await collect(response, JSON_BYTES, this.signal);
      if (body.length !== 0)
        fail(
          "unsupported_protocol",
          "A protocol notification returned an unsupported response body.",
        );
    }
  }
  private async refuse(envelope: RpcEnvelope): Promise<void> {
    if (
      typeof envelope.id !== "string" &&
      !(typeof envelope.id === "number" && Number.isSafeInteger(envelope.id))
    )
      fail(
        "unsupported_result",
        "The remote sent an invalid server request identifier.",
      );
    await this.empty(
      await this.send(
        {
          jsonrpc: "2.0",
          id: envelope.id,
          error: { code: -32601, message: "Client method not supported" },
        },
        true,
      ),
    );
  }
  private async envelope(
    message: RpcEnvelope,
    expectedId: string,
  ): Promise<{ result?: unknown; matched: boolean }> {
    if (message.jsonrpc !== "2.0")
      fail("unsupported_protocol", "The remote response is not JSON-RPC 2.0.");
    if (own(message, "method")) {
      if (
        typeof message.method !== "string" ||
        !own(message, "id") ||
        own(message, "result") ||
        own(message, "error")
      )
        fail(
          "unsupported_result",
          "The remote sent unsupported notification or interactive response framing.",
        );
      await this.refuse(message);
      return { matched: false };
    }
    if (
      Object.keys(message).some(
        (key) => !["jsonrpc", "id", "result", "error"].includes(key),
      ) ||
      message.id !== expectedId ||
      own(message, "result") === own(message, "error")
    )
      fail(
        "unsupported_result",
        "The remote response did not match the single expected request.",
      );
    if (own(message, "error")) {
      const error = message.error;
      if (
        !isJsonObject(error) ||
        !Number.isSafeInteger(error.code) ||
        typeof error.message !== "string"
      )
        fail(
          "unsupported_result",
          "The remote returned an invalid JSON-RPC error.",
        );
      fail(
        "upstream_rejected",
        "The remote rejected the MCP operation; the response is not proof of no effect.",
      );
    }
    return { matched: true, result: message.result };
  }
  private async read(response: Response, expectedId: string): Promise<unknown> {
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType === "application/json") {
      const message = strictObject(
        await collect(response, JSON_BYTES, this.signal),
      );
      const match = await this.envelope(message, expectedId);
      if (!match.matched)
        fail(
          "unsupported_result",
          "The remote did not return the requested result.",
        );
      return match.result;
    }
    if (mediaType !== "text/event-stream") {
      void cancel(response);
      fail(
        "unsupported_result",
        "The remote returned unsupported MCP response media.",
      );
    }
    decodedEncoding(response);
    if (!response.body)
      fail("unsupported_result", "The remote event response body is missing.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let wireBytes = 0,
      dataBytes = 0,
      events = 0;
    let lines: string[] = [],
      eventType = "",
      eventTouched = false;
    let matched = false,
      result: unknown;
    const dispatch = async () => {
      if (!eventTouched) return;
      if (++events > 64)
        fail(
          "payload_too_large",
          "The remote event response exceeds 64 events.",
        );
      if (lines.length) {
        if (eventType !== "" && eventType !== "message")
          fail(
            "unsupported_result",
            "The remote used unsupported event semantics.",
          );
        const source = lines.join("\n");
        dataBytes += encoder.encode(source).byteLength;
        if (dataBytes > JSON_BYTES)
          fail("payload_too_large", "The remote event data exceeds one MiB.");
        const response = await this.envelope(strictObject(source), expectedId);
        if (response.matched) {
          if (matched)
            fail(
              "unsupported_result",
              "The remote returned multiple results for one request.",
            );
          matched = true;
          result = response.result;
        }
      }
      lines = [];
      eventType = "";
      eventTouched = false;
    };
    const line = async (value: string) => {
      if (value === "") {
        await dispatch();
        return;
      }
      if (value.startsWith(":")) return; // SSE keepalive comment, never a capability or result.
      eventTouched = true;
      const colon = value.indexOf(":");
      const field = colon < 0 ? value : value.slice(0, colon);
      let text = colon < 0 ? "" : value.slice(colon + 1);
      if (text.startsWith(" ")) text = text.slice(1);
      if (field === "data") lines.push(text);
      else if (field === "event") eventType = text;
      else if (field === "id") {
        if (text.includes("\u0000"))
          fail(
            "unsupported_result",
            "The remote returned an invalid event identifier.",
          );
      } else if (field !== "retry")
        fail(
          "unsupported_result",
          "The remote returned unsupported event fields.",
        );
      else if (!/^\d+$/.test(text))
        fail(
          "unsupported_result",
          "The remote returned invalid event framing.",
        );
      // Event IDs/retry hints never authorize reconnect, replay or Last-Event-ID.
    };
    const fragments: string[] = [];
    let afterCarriageReturn = false;
    const consume = async (text: string) => {
      let start = 0;
      for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (afterCarriageReturn) {
          afterCarriageReturn = false;
          if (character === "\n") {
            start = index + 1;
            continue;
          }
        }
        if (character !== "\r" && character !== "\n") continue;
        fragments.push(text.slice(start, index));
        await line(fragments.join(""));
        fragments.length = 0;
        afterCarriageReturn = character === "\r";
        start = index + 1;
      }
      if (start < text.length) fragments.push(text.slice(start));
    };
    try {
      for (;;) {
        const part = await bounded(reader.read(), this.signal);
        if (part.done) {
          await consume(decoder.decode());
          break;
        }
        wireBytes += part.value.byteLength;
        if (wireBytes > FRAME_BYTES)
          fail(
            "payload_too_large",
            "The remote event response exceeds its framing limit.",
          );
        await consume(decoder.decode(part.value, { stream: true }));
      }
      // An event must have an actual empty-line terminator, not just a truncated EOF.
      if (fragments.length !== 0 || eventTouched)
        fail(
          "unsupported_result",
          "The remote event response ended with incomplete framing.",
        );
      if (!matched)
        fail(
          "unsupported_result",
          "The remote did not return the requested result.",
        );
      return result;
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (error instanceof RemoteMcpError) throw error;
      fail(
        "unsupported_result",
        "The remote event response is not valid bounded UTF-8.",
      );
    } finally {
      reader.releaseLock();
    }
  }
  async rpc(
    method: string,
    params: Record<string, unknown>,
    controlTraffic: boolean,
    onResponse?: (response: Response) => void,
  ): Promise<{ result: unknown; response: Response }> {
    const id = `${this.prefix}:${++this.sequence}`;
    const response = await this.send(
      { jsonrpc: "2.0", id, method, params },
      controlTraffic,
    );
    onResponse?.(response);
    return { response, result: await this.read(response, id) };
  }
  async initialize(): Promise<void> {
    const { result } = await this.rpc(
      "initialize",
      {
        protocolVersion: REMOTE_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "McpOne", version: "0.2.0-m2" },
      },
      true,
    );
    if (
      !isJsonObject(result) ||
      result.protocolVersion !== REMOTE_MCP_PROTOCOL_VERSION
    )
      fail(
        "unsupported_protocol",
        "The remote selected an unsupported MCP version.",
      );
    if (
      !isJsonObject(result.capabilities) ||
      !isJsonObject(result.capabilities.tools) ||
      !isJsonObject(result.serverInfo) ||
      typeof result.serverInfo.name !== "string" ||
      typeof result.serverInfo.version !== "string"
    )
      fail(
        "unsupported_protocol",
        "The remote did not declare a supported Tool capability.",
      );
    this.negotiated = true;
    await this.empty(
      await this.send(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        true,
      ),
    );
  }
  async cleanup(): Promise<void> {
    if (this.id === undefined) return;
    const cleanupClock = clock(Date.now() + (this.signal.aborted ? 1 : 1_000));
    try {
      const { headers, trustedHeaders } = this.headers();
      const pending = this.request({
        method: "DELETE",
        headers,
        trustedHeaders,
        controlTraffic: true,
        signal: cleanupClock.signal,
      });
      void pending.then(
        (response) => void cancel(response),
        () => undefined,
      );
      const response = await bounded(pending, cleanupClock.signal);
      void cancel(response);
    } catch {
      /* Best effort only. Cleanup failure is never business replay permission. */
    } finally {
      this.id = undefined;
      cleanupClock.close();
    }
  }
}

function rejection(
  upstreamName: string,
  path: string,
  code: string,
  message: string,
): ReviewRejected {
  return { upstreamName, path, code, message };
}
function normalizedName(upstream: string, namespace: string): string {
  let suffix = upstream
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(suffix)) suffix = `tool_${suffix}`;
  return `${namespace}.${suffix}`;
}
function rootAccountSelector(root: unknown): string | undefined {
  const visited = new Set<object>();
  function inspect(schema: unknown, path: string): string | undefined {
    if (!isJsonObject(schema) || visited.has(schema)) return;
    visited.add(schema);
    if (isJsonObject(schema.properties) && own(schema.properties, "_account"))
      return `${path}/properties/_account`;
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      const branches = schema[keyword];
      if (Array.isArray(branches))
        for (const [index, branch] of branches.entries()) {
          const collision = inspect(branch, `${path}/${keyword}/${index}`);
          if (collision) return collision;
        }
    }
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
      let target: unknown = root,
        fragment: string;
      try {
        fragment = decodeURIComponent(schema.$ref.slice(1));
      } catch {
        return;
      }
      for (const token of fragment.split("/").slice(1)) {
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!isJsonObject(target) || !own(target, key)) return;
        target = target[key];
      }
      return inspect(target, fragment);
    }
  }
  return inspect(root, "");
}

function normalizeManifest(
  manifest: Record<string, JSONValue>[],
  source: RemoteMcpSource,
  authentication: RemoteAuthentication | null,
): { accepted: ToolDefinition[]; rejected: ReviewRejected[] } {
  const accepted: ToolDefinition[] = [],
    rejected: ReviewRejected[] = [];
  const derived = createDerivedMetadataCounter();
  const rejectEntry = (entry: ReviewRejected) => {
    derived.add(entry);
    rejected.push(entry);
  };
  const nodes = new Set<object>();
  const candidates = new Map<
    string,
    { upstreamName: string; definition: ToolDefinition; path: string }[]
  >();
  const url = endpointUrl(source.endpoint);
  for (const [index, entry] of manifest.entries()) {
    const upstreamName = entry.name as string,
      path = `/tools/${index}`;
    const name = own(source.nameMapping, upstreamName)
      ? source.nameMapping[upstreamName]!
      : normalizedName(upstreamName, source.namespace);
    if (!name.startsWith(source.namespace + ".")) {
      rejectEntry(
        rejection(
          upstreamName,
          path + "/name",
          "name_collision",
          "Tool name must belong to the reviewed Integration namespace.",
        ),
      );
      continue;
    }
    const selector = rootAccountSelector(entry.inputSchema);
    if (selector) {
      rejectEntry(
        rejection(
          upstreamName,
          path + "/inputSchema" + selector,
          "name_collision",
          "The upstream Account selector collides with gateway authority and is unsupported.",
        ),
      );
      continue;
    }
    const schemaEntries = [
      ["inputSchema", entry.inputSchema],
      ...(own(entry, "outputSchema")
        ? [["outputSchema", entry.outputSchema]]
        : []),
    ] as const;
    let invalid = false;
    for (const [field, schema] of schemaEntries) {
      const structure = schemaStructureProblem(schema, nodes);
      const outcome = validateSchema(schema, {
        direction: field === "inputSchema" ? "request" : "response",
      });
      if (structure || !outcome.valid) {
        const issue = outcome.issues[0];
        rejectEntry(
          rejection(
            upstreamName,
            path + "/" + field + (issue?.schemaPath ?? ""),
            structure ? "schema_limit" : (issue?.code ?? "unsupported_schema"),
            structure
              ? "The manifest schema exceeds its shared structural limits."
              : (issue?.message ?? "The upstream schema is unsupported."),
          ),
        );
        invalid = true;
        break;
      }
    }
    if (invalid) continue;
    const requirement = authentication?.requirement ?? null;
    const parsed = ToolSchema.safeParse({
      name,
      upstreamName,
      description: entry.description ?? "",
      inputSchema: entry.inputSchema,
      ...(own(entry, "outputSchema")
        ? { outputSchema: entry.outputSchema }
        : {}),
      operationClass: "unknown",
      requirements: authentication
        ? { [authentication.requirement]: authentication.definition }
        : {},
      permissions: [
        {
          requirement,
          origin: url.origin,
          methods: ["POST", "DELETE"],
          path: url.pathname,
          match: "exact",
        },
      ],
      implementation: {
        kind: "remote_mcp",
        endpoint: source.endpoint,
        protocolVersion: REMOTE_MCP_PROTOCOL_VERSION,
        toolName: upstreamName,
        ...(source.connectionCredentialId
          ? { connectionCredentialId: source.connectionCredentialId }
          : {}),
      },
    });
    if (!parsed.success) {
      rejectEntry(
        rejection(
          upstreamName,
          path,
          "unsupported_schema",
          "The remote Tool cannot satisfy the normalized name, object schema or manifest contract.",
        ),
      );
      continue;
    }
    const group = candidates.get(name) ?? [];
    group.push({ upstreamName, definition: parsed.data, path });
    candidates.set(name, group);
  }
  for (const group of candidates.values()) {
    if (group.length === 1) {
      derived.add(group[0]!.definition);
      accepted.push(group[0]!.definition);
    } else
      for (const candidate of group)
        rejectEntry(
          rejection(
            candidate.upstreamName,
            candidate.path + "/name",
            "name_collision",
            "Multiple upstream Tools normalize to the same name; supply explicit distinct nameMapping entries.",
          ),
        );
  }
  return { accepted, rejected };
}
function redactJson(
  value: JSONValue,
  redact: (text: string) => string,
): JSONValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactJson(item, redact));
  if (value !== null && typeof value === "object") {
    const result: Record<string, JSONValue> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (redact(key) !== key)
        fail(
          "unsupported_result",
          "The remote response contains sensitive object identifiers.",
        );
      result[key] = redactJson(value[key]!, redact);
    }
    return result;
  }
  return value;
}
function normalizeResult(
  value: unknown,
  tool: ToolDefinition,
  redact: (text: string) => string,
): BusinessMcpResult {
  if (!isJsonObject(value) || jsonProblem(value))
    fail(
      "unsupported_result",
      "The remote Tool returned invalid or over-limit business JSON.",
    );
  if (isJsonObject(value._meta) && own(value._meta, EXECUTION_NAMESPACE))
    fail(
      "metadata_collision",
      "The remote Tool result collides with the reserved gateway metadata namespace.",
    );
  const parsed = BusinessResultSchema.safeParse(value);
  if (!parsed.success)
    fail(
      "unsupported_result",
      "The remote Tool returned unsupported content, metadata or interactive result fields; no content was dropped.",
    );
  if (
    tool.outputSchema &&
    (!parsed.data.structuredContent ||
      !validateInput(tool.outputSchema, parsed.data.structuredContent, {
        direction: "response",
      }).valid)
  )
    fail(
      "unsupported_result",
      "The remote structured result does not match the reviewed output schema.",
    );
  const safe = redactJson(parsed.data as JSONValue, redact);
  const safeResult = BusinessResultSchema.safeParse(safe);
  if (
    !safeResult.success ||
    (tool.outputSchema &&
      (!safeResult.data.structuredContent ||
        !validateInput(tool.outputSchema, safeResult.data.structuredContent, {
          direction: "response",
        }).valid))
  )
    fail(
      "unsupported_result",
      "The remote result could not be safely preserved under its reviewed output contract.",
    );
  return safeResult.data;
}
function trustedEffect(
  effect: unknown,
  fallback: EffectEvidence,
): EffectEvidence {
  const parsed = EffectSchema.safeParse(effect);
  return parsed.success ? parsed.data : fallback;
}

export function createRemoteMcpAdapter(dependencies: RemoteMcpDependencies) {
  return {
    async resolveTools(
      source: RemoteMcpSource,
      owner: RemoteOwnerContext,
    ): Promise<RemoteResolution> {
      const parsed = SourceSchema.safeParse(source);
      if (
        !parsed.success ||
        parsed.data.kind !== "remote_mcp" ||
        source.namespace !== owner.slug ||
        Object.values(source.nameMapping).some(
          (name) => !name.startsWith(owner.slug + "."),
        )
      )
        fail(
          "import_invalid",
          "Review the remote source namespace, endpoint and explicit name mappings.",
        );
      endpointUrl(source.endpoint);
      if (
        source.accountId &&
        (!dependencies.discoveryTransport ||
          !dependencies.describeAuthentication)
      )
        fail(
          "account_incompatible",
          "A trusted Provider adapter is required for the selected discovery Account.",
        );
      const authentication = dependencies.describeAuthentication
        ? await dependencies.describeAuthentication(
            owner,
            source.accountId,
            source.endpoint,
          )
        : null;
      if (source.accountId && !authentication)
        fail(
          "account_incompatible",
          "The selected discovery Account is not compatible with this endpoint.",
        );
      if (source.connectionCredentialId && !dependencies.connectionTransport)
        fail(
          "account_incompatible",
          "Trusted endpoint-bound credential custody is required.",
        );
      const transport = source.connectionCredentialId
        ? await dependencies.connectionTransport!(
            owner,
            source.connectionCredentialId,
            source.endpoint,
          )
        : source.accountId
          ? await dependencies.discoveryTransport!(
              owner,
              source.accountId,
              source.endpoint,
            )
          : dependencies.transport;
      const timer = clock(Date.now() + 10_000);
      const session = new Session(
        source.endpoint,
        ({ method, body, headers, trustedHeaders, signal }) => {
          for (const [name, value] of Object.entries(trustedHeaders))
            headers.set(name, value);
          return transport.request({
            method,
            url: source.endpoint,
            body,
            headers,
            signal,
            maxResponseBytes: FRAME_BYTES,
          });
        },
        timer.signal,
      );
      try {
        await session.initialize();
        const manifest: Record<string, JSONValue>[] = [];
        const names = new Set<string>(),
          cursors = new Set<string>();
        let cursor: string | undefined,
          aggregate = 0,
          pages = 0;
        do {
          if (++pages > 100)
            fail("import_invalid", "Remote discovery exceeds 100 list pages.");
          const { result } = await session.rpc(
            "tools/list",
            cursor === undefined ? {} : { cursor },
            true,
          );
          if (
            !isJsonObject(result) ||
            !Array.isArray(result.tools) ||
            (own(result, "nextCursor") &&
              (typeof result.nextCursor !== "string" ||
                result.nextCursor.length === 0 ||
                encoder.encode(result.nextCursor).byteLength > 8192))
          )
            fail(
              "import_invalid",
              "The remote returned a malformed Tool list page.",
            );
          aggregate += encoder.encode(canonicalJson(result)).byteLength;
          if (
            aggregate > MANIFEST_BYTES ||
            manifest.length + result.tools.length > 500
          )
            fail(
              "import_invalid",
              "Remote discovery exceeds the 500 Tool or five MiB manifest limit.",
            );
          for (const tool of result.tools) {
            if (
              !isJsonObject(tool) ||
              typeof tool.name !== "string" ||
              !tool.name.length ||
              tool.name.length > 4096 ||
              names.has(tool.name)
            )
              fail(
                "import_invalid",
                "The remote manifest has invalid or duplicate upstream Tool names.",
              );
            const redact = (text: string) =>
              session.redact(
                "redact" in transport && typeof transport.redact === "function"
                  ? transport.redact(text)
                  : text,
              );
            if (
              canonicalJson(redactJson(tool as JSONValue, redact)) !==
              canonicalJson(tool)
            )
              fail(
                "import_invalid",
                "The remote manifest contains credential material and cannot be safely reviewed.",
              );
            names.add(tool.name);
            manifest.push(tool as Record<string, JSONValue>);
          }
          cursor = result.nextCursor as string | undefined;
          if (cursor !== undefined) {
            if (cursors.has(cursor))
              fail("import_invalid", "The remote repeated a Tool list cursor.");
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        const normalized = normalizeManifest(manifest, source, authentication);
        return {
          ...normalized,
          snapshot: {
            endpoint: source.endpoint,
            protocolVersion: REMOTE_MCP_PROTOCOL_VERSION,
            sessionRequired: session.required,
            manifest,
            manifestDigest: await sha256(canonicalJson(manifest)),
            implementationPinned: false,
            limitation: REMOTE_IMPLEMENTATION_LIMITATION,
          },
        };
      } catch (error) {
        if (
          error instanceof RemoteMcpError ||
          error instanceof DerivedMetadataBudgetError
        )
          throw error;
        throw new RemoteMcpError(
          "upstream_unavailable",
          "Remote discovery could not complete; the previously reviewed manifest was not replaced.",
        );
      } finally {
        await session.cleanup();
        timer.close();
      }
    },
    async invokeTool(
      input: RemoteInvocation,
    ): Promise<{ result: BusinessMcpResult; effect: EffectEvidence }> {
      const definition = input.tool.definition;
      if (
        definition.implementation.kind !== "remote_mcp" ||
        definition.implementation.protocolVersion !==
          REMOTE_MCP_PROTOCOL_VERSION
      )
        fail(
          "unsupported_protocol",
          "The frozen Tool is not a supported remote MCP implementation.",
        );
      const implementation = definition.implementation;
      endpointUrl(implementation.endpoint);
      if (
        !isJsonObject(input.arguments) ||
        jsonProblem(input.arguments) ||
        !validateInput(definition.inputSchema, input.arguments, {
          direction: "request",
        }).valid ||
        own(input.arguments, "_account")
      )
        fail(
          "invalid_arguments",
          "Correct the business arguments against the reviewed Tool schema.",
        );
      const requirements = Object.keys(definition.requirements);
      if (requirements.length > 1)
        fail(
          "account_incompatible",
          "A remote MCP session requires one exact remote Account binding.",
        );
      const accountRequirement = requirements[0] ?? null;
      const timer = clock(input.deadlineMs);
      let attempted = false,
        effect: EffectEvidence = { state: "not_dispatched" };
      const session = new Session(
        implementation.endpoint,
        ({ method, body, headers, trustedHeaders, controlTraffic }) => {
          if (!controlTraffic) {
            attempted = true;
            effect = { state: "possible" };
          }
          // The broker owns compression negotiation; raw adapters cannot supply this routing header.
          headers.delete("accept-encoding");
          return input.broker.requestRaw({
            accountRequirement,
            method,
            url: implementation.endpoint,
            body,
            headers,
            mediaType: body ? "application/json" : undefined,
            maxResponseBytes: FRAME_BYTES,
            trustedHeaders,
            controlTraffic,
          });
        },
        timer.signal,
      );
      try {
        await session.initialize();
        const called = await session.rpc(
          "tools/call",
          { name: implementation.toolName, arguments: input.arguments },
          false,
          (response) => {
            const independent = dependencies.effectEvidence?.(
              definition,
              response,
            );
            if (independent !== undefined)
              effect = trustedEffect(independent, effect);
          },
        );
        const result = normalizeResult(
          called.result,
          definition,
          input.broker.redact?.bind(input.broker) ?? ((text) => text),
        );
        effect = dependencies.effectEvidence
          ? trustedEffect(
              dependencies.effectEvidence(definition, called.response, result),
              effect,
            )
          : { state: "completed" };
        return { result, effect };
      } catch (error) {
        // Evidence comes only from this Run-bound trusted capability, never from a guest/result field.
        const preserved =
          effect.state === "possible" || !attempted
            ? trustedEffect(
                input.broker.effect?.(),
                attempted ? effect : { state: "not_dispatched" },
              )
            : effect;
        if (error instanceof RemoteMcpError)
          throw new RemoteMcpError(error.code, error.message, preserved);
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? ExecutionErrorCode.safeParse(error.code)
            : undefined;
        if (code?.success)
          throw new RemoteMcpError(
            code.data,
            "The trusted broker rejected the current frozen Account or network authority.",
            preserved,
          );
        throw new RemoteMcpError(
          timer.signal.aborted ? "execution_timeout" : "upstream_unavailable",
          timer.signal.aborted
            ? "The remote Tool exceeded its execution deadline."
            : "The remote Tool call could not complete; inspect the recorded Run before invoking again.",
          preserved,
        );
      } finally {
        await session.cleanup();
        timer.close();
      }
    },
  };
}

/** Pure comparison only: publication, revision retention and restrictions remain catalogue-owned. */
export function classifyRemoteManifestDrift(
  previous: ToolDefinition[],
  refreshed: Pick<RemoteResolution, "accepted" | "rejected">,
) {
  const current = new Map(refreshed.accepted.map((tool) => [tool.name, tool]));
  const previousNames = new Set(previous.map((tool) => tool.name));
  const changes: {
    tool: string;
    kind: "new" | "unchanged" | "changed" | "removed";
  }[] = [];
  const oldAvailability: {
    tool: string;
    available: boolean;
    classification:
      | "unchanged"
      | "annotation_drift"
      | "contract_drift"
      | "removed"
      | "rejected";
  }[] = [];
  for (const old of previous) {
    const fresh = current.get(old.name);
    const rejected = refreshed.rejected.some(
      (entry) =>
        entry.upstreamName ===
        (old.upstreamName ??
          (old.implementation.kind === "remote_mcp"
            ? old.implementation.toolName
            : old.name)),
    );
    if (!fresh) {
      changes.push({ tool: old.name, kind: "removed" });
      oldAvailability.push({
        tool: old.name,
        available: false,
        classification: rejected ? "rejected" : "removed",
      });
    } else if (canonicalJson(old) === canonicalJson(fresh)) {
      changes.push({ tool: old.name, kind: "unchanged" });
      oldAvailability.push({
        tool: old.name,
        available: true,
        classification: "unchanged",
      });
    } else {
      const { description: _oldDescription, ...oldContract } = old;
      const { description: _freshDescription, ...freshContract } = fresh;
      const safe = canonicalJson(oldContract) === canonicalJson(freshContract);
      changes.push({ tool: old.name, kind: "changed" });
      oldAvailability.push({
        tool: old.name,
        available: safe,
        classification: safe ? "annotation_drift" : "contract_drift",
      });
    }
  }
  for (const fresh of refreshed.accepted)
    if (!previousNames.has(fresh.name))
      changes.push({ tool: fresh.name, kind: "new" });
  return {
    changes,
    oldAvailability,
    implementationPinned: false as const,
    limitation: REMOTE_IMPLEMENTATION_LIMITATION,
  };
}
