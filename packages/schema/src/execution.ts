import { z } from "zod";

/** M1 subset only; this does not freeze the full D12 import/runtime contract. */
export const EXECUTION_CONTRACT_VERSION = "0.1.1-m1" as const;
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;
export const EXECUTION_META_NAMESPACE =
  "com.toolcontrolplane/execution" as const;
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const EXECUTION_FALLBACK_PREFIX = "Tool Control Plane execution: ";

export const CallerExecutionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
export const CanonicalToolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
export const ExecutionRequestMetadata = z
  .object({
    idempotency_key: CallerExecutionId.optional(),
    trace_id: CallerExecutionId.optional(),
  })
  .strict();
export type ExecutionRequestMetadata = z.infer<typeof ExecutionRequestMetadata>;

export const ExecutionResponseMetadata = z
  .object({
    run_id: z.string().min(1),
    tool: CanonicalToolName,
    accounts: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();
export type ExecutionResponseMetadata = z.infer<
  typeof ExecutionResponseMetadata
>;

// Only our namespace is strict. Other MCP metadata belongs to its original owner.
export const McpRequestMeta = z
  .object({
    [EXECUTION_META_NAMESPACE]: ExecutionRequestMetadata.optional(),
  })
  .catchall(z.unknown());
export const McpResponseMeta = z
  .object({
    [EXECUTION_META_NAMESPACE]: ExecutionResponseMetadata,
  })
  .catchall(z.unknown());

export const PolicyDecision = z.enum(["allow", "ask", "block"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;
export const PolicyPattern = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?$/);
export const RunStatus = z.enum([
  "pending_approval",
  "queued",
  "running",
  "succeeded",
  "denied",
  "blocked",
  "expired",
  "canceled",
  "failed",
  "outcome_unknown",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ExecutionErrorCode = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_request",
  "invalid_arguments",
  "unsupported_protocol",
  "unsupported_feature",
  "payload_too_large",
  "idempotency_conflict",
  "policy_blocked",
  "approval_denied",
  "approval_expired",
  "grant_revoked",
  "grant_expired",
  "profile_disabled",
  "tool_unavailable",
  "canceled",
  "execution_failed",
  "execution_timeout",
  "outcome_unknown",
  "content_expired",
  "rate_limited",
  "internal_error",
]);
export type ExecutionErrorCode = z.infer<typeof ExecutionErrorCode>;
export const ExecutionError = z
  .object({
    code: ExecutionErrorCode,
    message: z.string().min(1),
    retryable: z.boolean(),
    run_id: z.string().min(1).optional(),
    retry_after_ms: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ExecutionError = z.infer<typeof ExecutionError>;

/** Separate text content-block fallback, never additional fields in MCP execution metadata. */
export const RunControl = ExecutionResponseMetadata.extend({
  status: RunStatus,
  approval_url: z.string().min(1).optional(),
  error: ExecutionError.optional(),
}).strict();
export type RunControl = z.infer<typeof RunControl>;
export const McpToolResult = z
  .object({
    content: z
      .array(z.object({ type: z.literal("text"), text: z.string() }).strict())
      .min(1),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean(),
    _meta: McpResponseMeta,
  })
  .strict();
export type McpToolResult = z.infer<typeof McpToolResult>;

export const McpRequest = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().min(1).max(128), z.number().int()]).optional(),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type McpRequest = z.infer<typeof McpRequest>;
export const InitializeParams = z
  .object({
    protocolVersion: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()),
    clientInfo: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        title: z.string().optional(),
      })
      .strict(),
    _meta: McpRequestMeta.optional(),
  })
  .strict();
export const ToolsListParams = z
  .object({
    _meta: McpRequestMeta.optional(),
  })
  .strict();
export const ToolsCallParams = z
  .object({
    name: CanonicalToolName,
    arguments: z.record(z.string(), z.unknown()).default({}),
    _meta: McpRequestMeta.optional(),
  })
  .strict();
export type ToolsCallParams = z.infer<typeof ToolsCallParams>;
export const RunsGetArguments = z
  .object({ run_id: z.string().min(1) })
  .strict();
export type RunsGetArguments = z.infer<typeof RunsGetArguments>;

export const FixtureArguments = z
  .object({
    value: z
      .number()
      .int()
      .min(Number.MIN_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .default(1),
    note: z.string().optional(),
    fault: z
      .enum(["safe_before_effect", "after_effect", "crash_after_claim"])
      .optional(),
  })
  .strict();
export type FixtureArguments = z.infer<typeof FixtureArguments>;

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** JCS rejects lone surrogates, including object property names, rather than repairing them. */
export const JcsValue = z.json().superRefine((value, ctx) => {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string" && hasLoneSurrogate(item)) {
      ctx.addIssue({
        code: "custom",
        message: "JSON contains an invalid Unicode string",
      });
      return;
    }
    if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (hasLoneSurrogate(key)) {
          ctx.addIssue({
            code: "custom",
            message: "JSON contains an invalid Unicode property name",
          });
          return;
        }
        pending.push(child);
      }
    }
  }
});
export const FingerprintPayload = z
  .object({
    version: z.literal("m1"),
    organization_id: z.string().min(1),
    grant_id: z.string().min(1),
    profile_id: z.string().min(1),
    tool: CanonicalToolName,
    tool_revision: z.string().min(1),
    accounts: z.record(z.string().min(1), z.string().min(1)),
    options: z.record(z.string(), JcsValue),
    arguments: z.record(z.string(), JcsValue),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!JcsValue.safeParse(value).success) {
      ctx.addIssue({
        code: "custom",
        message: "Fingerprint payload must be valid JCS JSON",
      });
    }
  });
export type FingerprintPayload = z.infer<typeof FingerprintPayload>;
