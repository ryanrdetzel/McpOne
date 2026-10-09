import {
  ArtifactRef,
  type EffectEvidence,
  HttpMethod,
  hasCodeUnitInRange,
  type JSONValue,
  jsonProblem,
  Permission,
  Requirement,
  type SelectedAccount,
} from "@scaffold/schema/integrations";
import { ControlError } from "../execution/service";
import { parseStrictJson } from "../strict-json";
import type { AccountsService } from "./accounts";
import {
  type HttpTransport,
  readBoundedBody,
  TransportError,
  validateTransportUrl,
} from "./transport";

export interface BrokerRequest {
  accountRequirement: string | null;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: JSONValue | string;
  mediaType?: string;
}
export interface BrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: JSONValue | string | { artifact: ArtifactRef };
}
export interface Broker {
  request(input: BrokerRequest): Promise<BrokerResponse>;
}
export interface RawBrokerRequest {
  accountRequirement: string | null;
  accountRequirements?: string[];
  method: HttpMethod;
  url: string;
  headers?: Headers | Record<string, string>;
  body?: Uint8Array;
  mediaType?: string;
  maxResponseBytes?: number;
  trustedHeaders?: Record<string, string>;
  controlTraffic?: boolean;
}
export interface BrokerAttempt {
  accountRequirement: string | null;
  accountRequirements?: string[];
  method: HttpMethod;
  url: string;
  controlTraffic?: boolean;
}
export interface TrustedBroker extends Broker {
  requestRaw(input: RawBrokerRequest): Promise<Response>;
  redact(text: string): string;
  effect(): EffectEvidence;
}
export interface BrokerOptions {
  transport: HttpTransport;
  accounts: AccountsService;
  orgId: string;
  principalId: string | null;
  requirements: Record<string, Requirement>;
  selections: Record<string, SelectedAccount>;
  permissions: Permission[];
  signal: AbortSignal;
  beforeRequest(input: BrokerAttempt): Promise<void>;
  artifact?: (response: Response) => Promise<ArtifactRef>;
  requestHeaders?: string[];
  responseHeaders?: string[];
  withBinaryAdmission?<T>(callback: () => Promise<T>): Promise<T>;
}
function redactDecodedJson(
  value: JSONValue,
  redact: (text: string) => string,
): JSONValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      value[index] = redactDecodedJson(value[index]!, redact);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (redact(key) !== key)
        throw new ControlError(
          "unsupported_result",
          "The upstream response contains sensitive object identifiers.",
          502,
        );
      value[key] = redactDecodedJson(value[key]!, redact);
    }
  }
  return value;
}

const encoder = new TextEncoder();
const DENIED =
  /^(?:host|authorization|proxy-authorization|cookie|set-cookie|connection|content-length|transfer-encoding|forwarded|x-forwarded-.*|proxy-connection|upgrade|te|trailer|accept-encoding)$/i;
// Response length is public receipt metadata, never a guest request override.
const DENIED_RESPONSE =
  /^(?:host|authorization|proxy-authorization|cookie|set-cookie|connection|transfer-encoding|forwarded|x-forwarded-.*|proxy-connection|upgrade|te|trailer|accept-encoding)$/i;
const DEFAULT_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "x-github-api-version",
];
const DEFAULT_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "retry-after",
];
const PROTOCOL_HEADERS = [
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];
function forbidden(): never {
  throw new ControlError(
    "broker_forbidden",
    "The request exceeds the reviewed network permission.",
    403,
  );
}
/** Validate raw pathname before URL normalization can erase traversal evidence. */
export function brokerUrl(input: string): URL {
  let url: URL;
  try {
    url = validateTransportUrl(input).url;
  } catch {
    forbidden();
  }
  if (url.port || !input.startsWith(`${url.origin}/`)) forbidden();
  const rawPath = input.slice(url.origin.length).split(/[?#]/)[0]!;
  if (
    !Permission.shape.path.safeParse(rawPath).success ||
    url.pathname !== rawPath
  )
    forbidden();
  if (
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.search) ||
    /%(?![0-9a-f]{2})/i.test(url.search)
  )
    forbidden();
  return url;
}
function matches(
  permission: Permission,
  requirement: string | null,
  method: HttpMethod,
  url: URL,
): boolean {
  return (
    permission.requirement === requirement &&
    permission.origin === url.origin &&
    permission.methods.includes(method) &&
    (permission.match === "exact"
      ? permission.path === url.pathname
      : permission.path === url.pathname ||
        url.pathname.startsWith(
          permission.path.endsWith("/")
            ? permission.path
            : `${permission.path}/`,
        ))
  );
}
function assertHeaderLimits(headers: Headers, generatedBytes: number): void {
  let total = generatedBytes;
  for (const [name, value] of headers) {
    const size = encoder.encode(value).length;
    if (size > 8192)
      throw new ControlError(
        "payload_too_large",
        "The request headers exceed their limit.",
        413,
      );
    total += encoder.encode(name).length + size + 4;
  }
  if (total > 16384)
    throw new ControlError(
      "payload_too_large",
      "The request headers exceed their limit.",
      413,
    );
}
export function createBroker(options: BrokerOptions): TrustedBroker {
  options = Object.freeze({ ...options });
  // Capture immutable authority, not references that a caller can mutate later.
  const requirements: Record<string, Requirement> = Object.create(null),
    selections: Record<string, SelectedAccount> = Object.create(null);
  for (const [name, value] of Object.entries(options.requirements))
    requirements[name] = Object.freeze(
      Requirement.parse(JSON.parse(JSON.stringify(value))),
    );
  for (const [name, value] of Object.entries(options.selections))
    selections[name] = Object.freeze({ ...value });
  const permissions = options.permissions.map((p) =>
    Object.freeze(Permission.parse(JSON.parse(JSON.stringify(p)))),
  );
  const requestHeaders = [
    ...DEFAULT_REQUEST_HEADERS,
    ...(options.requestHeaders ?? []).map((h) => h.toLowerCase()),
  ];
  const responseHeaders = [
    ...DEFAULT_RESPONSE_HEADERS,
    ...(options.responseHeaders ?? []).map((h) => h.toLowerCase()),
  ];
  if (
    requestHeaders.some(
      (h) => DENIED.test(h) || PROTOCOL_HEADERS.includes(h),
    ) ||
    responseHeaders.some(
      (h) => DENIED_RESPONSE.test(h) || PROTOCOL_HEADERS.includes(h),
    )
  )
    forbidden();
  const redactors: ((text: string) => string)[] = [];
  const unresolved = new Set<number>();
  const responseAttempts = new WeakMap<Response, number[]>();
  let nextAttempt = 0,
    completedAny = false,
    noSendWitness = false;
  function acknowledgeGuest(response: Response): void {
    const attempts = responseAttempts.get(response);
    if (!attempts)
      throw new ControlError(
        "internal_error",
        "The response acknowledgement is unavailable.",
        500,
      );
    for (const attempt of attempts) unresolved.delete(attempt);
    if (attempts.length) completedAny = true;
    responseAttempts.delete(response);
  }
  function transportFailure(error: TransportError): ControlError {
    if (!error.mayHaveDispatched) noSendWitness = true;
    if (
      [
        "response_too_large",
        "invalid_response",
        "unsupported_encoding",
      ].includes(error.code)
    )
      return new ControlError(
        "unsupported_result",
        "The upstream response is malformed or exceeds its supported limit.",
        502,
      );
    if (
      ["unsafe_target", "invalid_request", "unsupported_destination"].includes(
        error.code,
      )
    )
      return new ControlError(
        "broker_forbidden",
        "The request exceeds the reviewed network permission.",
        403,
      );
    if (
      !error.mayHaveDispatched &&
      ["dns_failure", "connection_failure", "timeout"].includes(error.code)
    )
      return new ControlError(
        "upstream_unavailable",
        "The upstream connection failed before any HTTP request bytes were written.",
        503,
        undefined,
        true,
      );
    if (["timeout", "aborted"].includes(error.code))
      return new ControlError(
        "execution_timeout",
        "The execution deadline expired.",
        502,
      );
    return new ControlError(
      "upstream_unavailable",
      "The upstream request could not be completed safely.",
      503,
    );
  }
  function safeHeaders(
    input: Headers | Record<string, string> | undefined,
    trusted?: Record<string, string>,
  ): Headers {
    const headers = new Headers();
    let total = 0;
    const entries =
      input instanceof Headers
        ? [...input.entries()]
        : Object.entries(input ?? {});
    for (const [original, value] of entries) {
      const name = original.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
        DENIED.test(name) ||
        !requestHeaders.includes(name) ||
        typeof value !== "string" ||
        hasCodeUnitInRange(value, 0, 31) ||
        value.includes("\x7f") ||
        encoder.encode(value).length > 8192 ||
        headers.has(name)
      )
        forbidden();
      total += encoder.encode(name + value).length + 4;
      headers.set(name, value);
    }
    for (const [name, value] of Object.entries(trusted ?? {})) {
      if (
        !PROTOCOL_HEADERS.includes(name.toLowerCase()) ||
        typeof value !== "string" ||
        !/^[\x20-\x7e]{1,1024}$/.test(value) ||
        headers.has(name)
      )
        forbidden();
      total += name.length + value.length + 4;
      headers.set(name, value);
      // Session IDs are trusted transport-only correlation, never guest output.
      if (name.toLowerCase() === "mcp-session-id")
        redactors.push((text) => text.split(value).join("[redacted]"));
    }
    if (total > 16384) forbidden();
    headers.set("accept-encoding", "identity");
    return headers;
  }
  const broker: TrustedBroker = {
    effect() {
      return unresolved.size
        ? { state: "possible" }
        : completedAny
          ? { state: "completed" }
          : noSendWitness
            ? {
                state: "verified_no_effect",
                reason:
                  "The trusted transport verified that no HTTP request bytes were written.",
              }
            : { state: "not_dispatched" };
    },
    redact(text) {
      for (const redact of redactors) text = redact(text);
      return text;
    },
    async requestRaw(input) {
      try {
        const dispatched: number[] = [];
        if (
          !HttpMethod.safeParse(input.method).success ||
          (input.body !== undefined &&
            (!(input.body instanceof Uint8Array) ||
              input.body.byteLength > 27328512)) ||
          (input.body !== undefined && ["GET", "HEAD"].includes(input.method))
        )
          forbidden();
        const maxResponseBytes = input.maxResponseBytes ?? 1048576;
        if (
          !Number.isInteger(maxResponseBytes) ||
          maxResponseBytes < 0 ||
          maxResponseBytes > 26214400
        )
          forbidden();
        const keys = input.accountRequirements ?? [input.accountRequirement];
        if (
          input.accountRequirements &&
          (input.accountRequirement !== null ||
            keys.length < 1 ||
            keys.length > 8 ||
            new Set(keys).size !== keys.length ||
            keys.some((key) => key === null))
        )
          forbidden();
        if (
          keys.some(
            (key) =>
              key !== null &&
              (!Object.hasOwn(requirements, key) ||
                !Object.hasOwn(selections, key)),
          )
        )
          forbidden();
        let method = input.method,
          body = input.body,
          url = brokerUrl(input.url),
          redirects = 0;
        while (true) {
          if (options.signal.aborted)
            throw new ControlError(
              "execution_timeout",
              "The execution deadline expired.",
              502,
            );
          for (const key of keys)
            if (!permissions.some((p) => matches(p, key, method, url)))
              forbidden();
          let headers = safeHeaders(input.headers, input.trustedHeaders);
          if (input.mediaType) {
            if (
              !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; boundary=[A-Za-z0-9_-]{1,70})?$/.test(
                input.mediaType,
              ) ||
              (headers.has("content-type") &&
                headers.get("content-type") !== input.mediaType)
            )
              forbidden();
            headers.set("content-type", input.mediaType);
          }
          const framingBytes = encoder.encode(
            `host: ${url.host}\r\nconnection: close\r\n${body !== undefined ? `content-length: ${body.byteLength}\r\n` : ""}\r\n`,
          ).length;
          assertHeaderLimits(headers, framingBytes);
          const attempt: BrokerAttempt = {
            accountRequirement: input.accountRequirement,
            ...(input.accountRequirements
              ? { accountRequirements: [...input.accountRequirements] }
              : {}),
            method,
            url: url.href,
            ...(input.controlTraffic ? { controlTraffic: true } : {}),
          };
          let fenced = false;
          for (const [index, key] of keys.entries()) {
            if (key === null) continue;
            const authorized = await options.accounts.authorize({
              orgId: options.orgId,
              principalId: options.principalId,
              requirement: requirements[key]!,
              selection: selections[key]!,
              url: url.href,
              headers,
              beforeProviderRequest: (providerAttempt) =>
                options.beforeRequest({ ...attempt, ...providerAttempt }),
              beforeCredentialUse:
                index === keys.length - 1
                  ? async (budget) => {
                      if (
                        budget.totalBytes + framingBytes > 16384 ||
                        budget.maxValueBytes > 8192
                      )
                        throw new ControlError(
                          "payload_too_large",
                          "The credential-bearing request headers exceed their limit.",
                          413,
                        );
                      await options.beforeRequest(attempt);
                      fenced = true;
                    }
                  : undefined,
            });
            headers = authorized.headers;
            redactors.push(authorized.redact);
          }
          assertHeaderLimits(headers, framingBytes);
          if (!fenced) await options.beforeRequest(attempt);
          const attemptId = input.controlTraffic ? undefined : ++nextAttempt;
          if (attemptId !== undefined) {
            unresolved.add(attemptId);
            dispatched.push(attemptId);
          }
          let response: Response;
          try {
            response = await options.transport.request({
              url: url.href,
              method,
              headers,
              body,
              signal: options.signal,
              maxResponseBytes,
            });
          } catch (error) {
            if (error instanceof TransportError) {
              if (!error.mayHaveDispatched && attemptId !== undefined)
                unresolved.delete(attemptId);
              throw transportFailure(error);
            }
            throw new ControlError(
              "upstream_unavailable",
              "The upstream request could not be completed safely.",
              503,
            );
          }
          if (![301, 302, 303, 307, 308].includes(response.status)) {
            responseAttempts.set(response, dispatched);
            return response;
          }
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (
            !location ||
            redirects++ >= 3 ||
            hasCodeUnitInRange(location, 0, 32) ||
            location.includes("\x7f") ||
            location.includes("\\")
          )
            forbidden();
          const redirectPath = location
            .replace(/^https:\/\/[^/]+/i, "")
            .split(/[?#]/)[0]!;
          if (
            location.includes("#") ||
            /%(?:2f|5c|00)/i.test(redirectPath) ||
            /%(?![0-9a-f]{2})/i.test(redirectPath) ||
            redirectPath.split("/").some((segment) => {
              try {
                const decoded = decodeURIComponent(segment);
                return decoded === "." || decoded === "..";
              } catch {
                return true;
              }
            })
          )
            forbidden();
          if (
            (response.status === 301 || response.status === 302) &&
            !["GET", "HEAD"].includes(method)
          )
            forbidden();
          if (
            (response.status === 307 || response.status === 308) &&
            !["GET", "HEAD"].includes(method)
          )
            forbidden();
          if (response.status === 303) {
            method = "GET";
            body = undefined;
          }
          const next = new URL(location, url);
          // A credential URL is never forwarded to a new origin without explicit
          // permission and fresh Account-bound injection; every hop is rebuilt.
          url = brokerUrl(next.href);
        }
      } catch (error) {
        if (
          error instanceof ControlError &&
          "mayHaveDispatched" in error &&
          error.mayHaveDispatched === false
        )
          noSendWitness = true;
        const failure =
          error instanceof TransportError
            ? transportFailure(error)
            : error instanceof ControlError
              ? error
              : new ControlError(
                  "upstream_unavailable",
                  "The request could not be completed safely.",
                  503,
                );
        throw Object.assign(failure, { effect: broker.effect() });
      }
    },
    async request(input) {
      const execute = async (): Promise<BrokerResponse> => {
        if (
          !input ||
          typeof input !== "object" ||
          Object.keys(input).some(
            (k) =>
              ![
                "accountRequirement",
                "method",
                "url",
                "headers",
                "body",
                "mediaType",
              ].includes(k),
          ) ||
          (input.accountRequirement !== null &&
            typeof input.accountRequirement !== "string") ||
          typeof input.url !== "string"
        )
          forbidden();
        if (
          input.headers !== undefined &&
          (input.headers === null ||
            typeof input.headers !== "object" ||
            Array.isArray(input.headers) ||
            input.headers instanceof Headers)
        )
          forbidden();
        if (
          input.mediaType !== undefined &&
          typeof input.mediaType !== "string"
        )
          forbidden();
        let body: Uint8Array | undefined;
        if (input.body !== undefined) {
          if (jsonProblem(input.body))
            throw new ControlError(
              "invalid_arguments",
              "The request body is not bounded valid JSON.",
              400,
            );
          const mediaType =
            input.mediaType ??
            (typeof input.body === "string"
              ? "text/plain"
              : "application/json");
          if (/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mediaType))
            body = encoder.encode(JSON.stringify(input.body));
          else if (mediaType === "text/plain" && typeof input.body === "string")
            body = encoder.encode(input.body);
          else forbidden();
          input = { ...input, mediaType };
          if (body.byteLength > 1048576)
            throw new ControlError(
              "payload_too_large",
              "The inline request body exceeds its limit.",
              413,
            );
        }
        if (options.artifact && !options.withBinaryAdmission)
          throw new ControlError(
            "capacity_exceeded",
            "Binary artifact admission is unavailable.",
            429,
          );
        const response = await broker.requestRaw({
          ...input,
          body,
          maxResponseBytes: options.artifact ? 26214400 : 1048576,
        });
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel();
          throw new ControlError(
            "upstream_rejected",
            "The upstream rejected the request. Inspect the Account and reviewed request.",
            502,
          );
        }
        const headers: Record<string, string> = Object.create(null);
        for (const name of responseHeaders) {
          const value = response.headers.get(name);
          if (
            value !== null &&
            !hasCodeUnitInRange(value, 0, 31) &&
            !value.includes("\x7f") &&
            (name !== "content-length" || /^\d{1,9}$/.test(value))
          )
            headers[name] = broker.redact(value);
        }
        if (input.method === "HEAD" || response.status === 204) {
          await response.body?.cancel();
          acknowledgeGuest(response);
          return { status: response.status, headers, body: "" };
        }
        const mediaType = (response.headers.get("content-type") ?? "")
          .split(";")[0]!
          .trim()
          .toLowerCase();
        const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)"?/i
          .exec(response.headers.get("content-type") ?? "")?.[1]
          ?.toLowerCase();
        if (
          (charset &&
            !["utf-8", "utf8"].includes(charset) &&
            (/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mediaType) ||
              mediaType === "text/plain")) ||
          (response.headers.get("content-encoding") &&
            response.headers.get("content-encoding") !== "identity")
        ) {
          await response.body?.cancel();
          throw new ControlError(
            "unsupported_result",
            "The upstream charset or encoding is not supported.",
            502,
          );
        }
        if (
          /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mediaType) ||
          mediaType === "text/plain"
        ) {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              await readBoundedBody(response.body, 1048576, options.signal),
            );
          } catch {
            throw new ControlError(
              "unsupported_result",
              "The upstream result is malformed or exceeds its supported limit.",
              502,
            );
          }
          text = broker.redact(text);
          if (mediaType === "text/plain") {
            acknowledgeGuest(response);
            return { status: response.status, headers, body: text };
          }
          let parsed: unknown;
          try {
            parsed = parseStrictJson(text);
            if (jsonProblem(parsed)) throw new Error();
            parsed = redactDecodedJson(parsed as JSONValue, broker.redact);
          } catch {
            throw new ControlError(
              "unsupported_result",
              "The upstream JSON result is not supported.",
              502,
            );
          }
          acknowledgeGuest(response);
          return {
            status: response.status,
            headers,
            body: parsed as JSONValue,
          };
        }
        if (
          !mediaType ||
          ["text/event-stream", "application/x-ndjson"].includes(mediaType) ||
          !options.artifact
        ) {
          await response.body?.cancel();
          throw new ControlError(
            "unsupported_result",
            "The upstream media type is not supported.",
            502,
          );
        }
        const ready = ArtifactRef.safeParse(await options.artifact(response));
        if (!ready.success)
          throw new ControlError(
            "unsupported_result",
            "The binary result did not produce a supported ready Artifact.",
            502,
          );
        const artifact = ready.data;
        acknowledgeGuest(response);
        return { status: response.status, headers, body: { artifact } };
      };
      try {
        return await (options.withBinaryAdmission
          ? options.withBinaryAdmission(execute)
          : execute());
      } catch (error) {
        const failure =
          error instanceof ControlError
            ? error
            : new ControlError(
                "unsupported_result",
                "The request could not produce a supported bounded result.",
                502,
              );
        throw Object.assign(failure, { effect: broker.effect() });
      }
    },
  };
  return Object.freeze(broker);
}
