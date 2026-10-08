import type { Env } from "@scaffold/config";
import {
  EXECUTION_CONTRACT_VERSION,
  EXECUTION_FALLBACK_PREFIX,
  EXECUTION_META_NAMESPACE,
  ExecutionResponseMetadata,
  InitializeParams,
  MCP_PROTOCOL_VERSION,
  McpRequest,
  RunControl,
  RunsGetArguments,
  ToolsCallParams,
  ToolsListParams,
} from "@scaffold/schema/execution";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { ControlError, type createExecutionService } from "./execution/service";
import { readJsonBody } from "./strict-json";

type Service = ReturnType<typeof createExecutionService>;
type RunView = Awaited<ReturnType<Service["getRun"]>>;
const responseEncoder = new TextEncoder();
// Service validation records malformed business inputs/metadata as durable failed Runs.
const InvocationEnvelope = ToolsCallParams.omit({
  arguments: true,
  _meta: true,
}).extend({
  arguments: z.unknown().default({}),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

function toolResult(run: RunView) {
  const provenance = { run_id: run.runId, tool: run.tool };
  const control = RunControl.parse({
    ...provenance,
    status: run.status,
    ...(run.approvalLink ? { approval_url: run.approvalLink } : {}),
    ...(run.error ? { error: run.error } : {}),
  });
  const content = [];
  if (run.result !== undefined)
    content.push({ type: "text" as const, text: JSON.stringify(run.result) });
  content.push({
    type: "text" as const,
    text: EXECUTION_FALLBACK_PREFIX + JSON.stringify(control),
  });
  return {
    content,
    ...(run.result &&
    typeof run.result === "object" &&
    !Array.isArray(run.result)
      ? { structuredContent: run.result }
      : {}),
    isError:
      Boolean(run.error) ||
      [
        "denied",
        "blocked",
        "expired",
        "canceled",
        "failed",
        "outcome_unknown",
      ].includes(run.status),
    _meta: { [EXECUTION_META_NAMESPACE]: provenance },
  };
}

/** Stateless Streamable HTTP JSON responses; durable Runs outlive all MCP connections. */
export function createMcpRoutes(service: Service, env: Env) {
  const app = new Hono();
  app.all("/:profileId", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json(
        {
          error: {
            code: "unsupported_feature",
            message: "Use MCP Streamable HTTP POST",
            retryable: false,
          },
        },
        405,
      );
    }
    const origin = c.req.header("Origin");
    if (origin && !env.TRUSTED_ORIGINS.includes(origin)) {
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "Untrusted request origin",
            retryable: false,
          },
        },
        403,
      );
    }
    let id: string | number | null = null;
    const rpcError = (
      code: number,
      data: {
        code: string;
        message: string;
        retryable: boolean;
        run_id?: string;
      },
      status: ContentfulStatusCode = 200,
    ) =>
      c.json(
        { jsonrpc: "2.0", id, error: { code, message: data.message, data } },
        status,
      );
    try {
      const authorization = c.req.header("Authorization") ?? "";
      const match = /^Bearer ([^\s]+)$/.exec(authorization);
      const grant = await service.authenticate(
        c.req.param("profileId"),
        match?.[1] ?? "",
      );
      const accept = c.req.header("Accept") ?? "";
      if (
        !accept.includes("application/json") ||
        !accept.includes("text/event-stream")
      ) {
        return rpcError(
          -32600,
          {
            code: "invalid_request",
            message:
              "Accept must include application/json and text/event-stream",
            retryable: false,
          },
          406,
        );
      }
      if (
        !(c.req.header("Content-Type") ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        return rpcError(
          -32600,
          {
            code: "invalid_request",
            message: "JSON content type required",
            retryable: false,
          },
          415,
        );
      }
      let raw: unknown;
      try {
        raw = await readJsonBody(c.req.raw);
      } catch (error) {
        const oversized = error instanceof RangeError;
        return rpcError(
          oversized ? -32600 : -32700,
          {
            code: oversized ? "payload_too_large" : "invalid_request",
            message: oversized
              ? "MCP request exceeds 1 MiB"
              : "Invalid JSON request",
            retryable: false,
          },
          oversized ? 413 : 400,
        );
      }
      const parsed = McpRequest.safeParse(raw);
      if (!parsed.success)
        return rpcError(
          -32600,
          {
            code: "invalid_request",
            message: "Invalid MCP request envelope",
            retryable: false,
          },
          400,
        );
      const request = parsed.data;
      id = request.id ?? null;
      if (
        request.method !== "initialize" &&
        c.req.header("MCP-Protocol-Version") !== MCP_PROTOCOL_VERSION
      ) {
        return rpcError(
          -32600,
          {
            code: "unsupported_protocol",
            message: `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`,
            retryable: false,
          },
          400,
        );
      }
      // Notifications have no response ID and never enter business dispatch.
      if (request.id === undefined) return c.body(null, 202);
      const respond = (result: unknown) => {
        const bytes = responseEncoder.encode(
          JSON.stringify({ jsonrpc: "2.0", id, result }),
        );
        if (bytes.byteLength > 1024 * 1024) {
          const meta =
            result !== null && typeof result === "object" && "_meta" in result
              ? result._meta
              : undefined;
          const executionMeta =
            meta !== null &&
            typeof meta === "object" &&
            EXECUTION_META_NAMESPACE in meta
              ? meta[EXECUTION_META_NAMESPACE]
              : undefined;
          const provenance = ExecutionResponseMetadata.safeParse(executionMeta);
          return rpcError(-32000, {
            code: "payload_too_large",
            message:
              "MCP response exceeds 1 MiB. Any recorded Run remains authoritative; do not replay effects.",
            retryable: false,
            ...(provenance.success && provenance.data.run_id.length <= 128
              ? { run_id: provenance.data.run_id }
              : {}),
          });
        }
        return c.newResponse(bytes, 200, {
          "Content-Type": "application/json; charset=UTF-8",
        });
      };
      switch (request.method) {
        case "initialize": {
          if (!InitializeParams.safeParse(request.params).success)
            return rpcError(-32602, {
              code: "invalid_request",
              message: "Invalid initialize parameters",
              retryable: false,
            });
          return respond({
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "tool-control-plane",
              version: EXECUTION_CONTRACT_VERSION,
            },
            instructions:
              "Sensitive calls pause for owner approval. Use runs.get to retrieve durable results without repeating effects.",
          });
        }
        case "ping":
          return respond({});
        case "tools/list": {
          if (!ToolsListParams.safeParse(request.params ?? {}).success)
            return rpcError(-32602, {
              code: "invalid_request",
              message: "Invalid tools/list parameters",
              retryable: false,
            });
          const tools = await service.discover(grant);
          return respond({ tools });
        }
        case "tools/call": {
          const input = InvocationEnvelope.safeParse(request.params);
          if (!input.success)
            return rpcError(-32602, {
              code: "invalid_request",
              message: "Invalid tools/call parameters or execution metadata",
              retryable: false,
            });
          if (input.data.name === "runs.get") {
            const args = RunsGetArguments.safeParse(input.data.arguments);
            if (!args.success)
              return rpcError(-32602, {
                code: "invalid_arguments",
                message: "runs.get requires a run_id",
                retryable: false,
              });
            return respond(
              toolResult(await service.getRun(grant, args.data.run_id)),
            );
          }
          let run: RunView;
          try {
            run = await service.invoke(grant, {
              name: input.data.name,
              arguments: input.data.arguments,
              metadata: input.data._meta?.[EXECUTION_META_NAMESPACE],
            });
          } catch (error) {
            if (
              !(error instanceof ControlError) ||
              error.code !== "idempotency_conflict" ||
              !error.runId
            )
              throw error;
            const previous = await service.getRun(grant, error.runId);
            return respond(
              toolResult({
                ...previous,
                result: undefined,
                error: {
                  code: error.code,
                  message: error.message,
                  retryable: false,
                  run_id: previous.runId,
                },
              }),
            );
          }
          await service.drain();
          return respond(toolResult(await service.getRun(grant, run.runId)));
        }
        default:
          return rpcError(-32601, {
            code: "unsupported_feature",
            message: "MCP method is not supported by the M1 contract",
            retryable: false,
          });
      }
    } catch (error) {
      if (error instanceof ControlError) {
        return rpcError(
          -32000,
          {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.runId ? { run_id: error.runId } : {}),
          },
          error.status as ContentfulStatusCode,
        );
      }
      return rpcError(
        -32603,
        {
          code: "internal_error",
          message: "Gateway operation failed",
          retryable: false,
        },
        500,
      );
    }
  });
  return app;
}
