import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Env } from "@scaffold/config";
import {
  ExecutionError,
  PolicyDecision,
  PolicyPattern,
  RunStatus,
} from "@scaffold/schema/execution";
import { jsonProblem } from "@scaffold/schema/integrations";
import type { Context } from "hono";
import {
  ControlError,
  type ExecutionService,
  type RunView,
} from "./execution/service";
import type { OrgRoleResult } from "./guard";
import {
  type IntegrationApi,
  type IntegrationApiSchema,
  type IntegrationOwnerServices,
  IntegrationRoutes,
} from "./integrations/routes";
import { readJsonBody } from "./strict-json";

type Owner = Extract<OrgRoleResult, { ok: true }>;
const Id = z.string().uuid();
const ProfileParams = z.object({ profileId: Id });
const RunParams = z.object({ runId: Id });
const GrantParams = z.object({ grantId: Id });
const Label = z.string().trim().min(1).max(100);
const Rules = z
  .object({
    rules: z
      .array(
        z.object({ pattern: PolicyPattern, decision: PolicyDecision }).strict(),
      )
      .max(100),
  })
  .strict();
const Ok = z.object({ ok: z.literal(true) });
const Run = z
  .object({
    runId: Id,
    tool: z.string(),
    status: RunStatus,
    createdAt: z.string().datetime(),
    deadline: z.string().datetime().nullable(),
    grantId: Id,
    profileId: Id,
    approvalLink: z.string().optional(),
    error: ExecutionError.optional(),
    result: z.unknown().optional(),
    attempts: z.number().int(),
    outboundRequests: z.number().int().min(0).max(30).optional(),
    effectState: z
      .enum([
        "not_dispatched",
        "verified_no_effect",
        "provider_idempotent",
        "possible",
        "completed",
      ])
      .optional(),
    logs: z
      .array(
        z
          .object({
            level: z.enum(["log", "info", "warn", "error"]),
            text: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .passthrough();
const ErrorBody = z.object({ error: ExecutionError });
const json = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});
const errors = {
  400: { description: "Invalid control request", ...json(ErrorBody) },
  401: { description: "Owner authentication required", ...json(ErrorBody) },
  403: { description: "Workspace owner required", ...json(ErrorBody) },
  404: { description: "Resource unavailable", ...json(ErrorBody) },
  409: {
    description: "Transition conflicts with current state",
    ...json(ErrorBody),
  },
};

/** Domain/SQL clocks use epoch milliseconds; public dates follow the API blueprint. */
function ownerRunView(run: RunView): z.infer<typeof Run> {
  return {
    ...run,
    createdAt: new Date(run.createdAt).toISOString(),
    deadline:
      run.deadline === null ? null : new Date(run.deadline).toISOString(),
  };
}

/** Owner administration is never authorized by a Profile Grant. */
export class ControlRoutes {
  readonly api;

  constructor({
    service,
    env,
    requireOrgRole,
    integrations,
  }: {
    service: ExecutionService;
    env: Env;
    integrations?: IntegrationOwnerServices;
    requireOrgRole(
      c: Context,
      roles: readonly string[],
    ): Promise<OrgRoleResult>;
  }) {
    const api = new OpenAPIHono<{ Variables: { owner: Owner } }>({
      defaultHook: (result, c) => {
        if (!result.success)
          return c.json(
            {
              error: {
                code: "invalid_request" as const,
                message: "Invalid control request",
                retryable: false,
              },
            },
            400,
          );
      },
    });
    api.use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      const origin = c.req.header("Origin");
      if (origin && !env.TRUSTED_ORIGINS.includes(origin)) {
        return c.json(
          {
            error: {
              code: "forbidden" as const,
              message: "Untrusted request origin",
              retryable: false,
            },
          },
          403,
        );
      }
      const owner = await requireOrgRole(c, ["owner"]);
      if (!owner.ok) {
        const unauthenticated = owner.error === "unauthenticated";
        return c.json(
          {
            error: {
              code: unauthenticated
                ? ("unauthenticated" as const)
                : ("forbidden" as const),
              message: "Workspace owner session required",
              retryable: false,
            },
          },
          unauthenticated ? 401 : 403,
        );
      }
      c.set("owner", owner);
      const binaryUpload =
        c.req.method === "POST" && c.req.path.endsWith("/artifacts");
      if (
        !binaryUpload &&
        c.req.raw.body &&
        (c.req.header("Content-Type") ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        try {
          const body = await readJsonBody(
            c.req.raw.clone(),
            c.req.path.includes("/integrations")
              ? 12 * 1024 * 1024
              : 1024 * 1024,
            128,
          );
          if (
            jsonProblem(
              body,
              c.req.path.includes("/integrations")
                ? 12 * 1024 * 1024
                : 1024 * 1024,
              128,
            )
          )
            throw new SyntaxError("Invalid bounded JSON");
          c.req.json = async <T>() => body as T;
        } catch (error) {
          return c.json(
            {
              error: {
                code:
                  error instanceof RangeError
                    ? "payload_too_large"
                    : "invalid_request",
                message: "Invalid bounded control request.",
                retryable: false,
              },
            },
            error instanceof RangeError ? 413 : 400,
          );
        }
      }
      await next();
    });
    api.onError((error, c) => {
      if (error instanceof ControlError) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.runId ? { run_id: error.runId } : {}),
            },
          },
          error.status as 400,
        );
      }
      // Do not log exception messages here: adapter exceptions may include SQL parameters.
      return c.json(
        {
          error: {
            code: "internal_error",
            message: "Control operation failed",
            retryable: false,
          },
        },
        500,
      );
    });

    const controlApi = api
      .openapi(
        createRoute({
          method: "post",
          path: "/setup",
          request: {
            body: {
              required: true,
              ...json(z.object({ label: Label }).strict()),
            },
          },
          responses: {
            200: {
              description: "Fixture Profile provisioned",
              ...json(z.object({ profileId: Id, tool: z.string() })),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await service.setup(
              c.get("owner").organizationId,
              c.req.valid("json").label,
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/profiles/{profileId}/grants",
          request: {
            params: ProfileParams,
            body: {
              required: true,
              ...json(
                z
                  .object({
                    label: Label,
                    expiresAt: z.string().datetime().nullable().optional(),
                  })
                  .strict(),
              ),
            },
          },
          responses: {
            200: {
              description: "New separately labeled Grant; token shown once",
              ...json(
                z.object({
                  grantId: Id,
                  token: z.string(),
                  expiresAt: z.string().datetime().nullable(),
                }),
              ),
            },
            ...errors,
          },
        }),
        async (c) => {
          const input = c.req.valid("json");
          const grant = await service.issueGrant(
            c.get("owner").organizationId,
            c.req.valid("param").profileId,
            input.label,
            input.expiresAt == null
              ? input.expiresAt
              : Date.parse(input.expiresAt),
            c.get("owner").userId,
          );
          return c.json(
            {
              ...grant,
              expiresAt:
                grant.expiresAt === null
                  ? null
                  : new Date(grant.expiresAt).toISOString(),
            },
            200,
          );
        },
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/profiles/{profileId}",
          request: {
            params: ProfileParams,
            body: {
              required: true,
              ...json(
                z
                  .object({
                    enabled: z.boolean().optional(),
                    toolEnabled: z.boolean().optional(),
                    approvalLifetimeMs: z
                      .number()
                      .int()
                      .min(15 * 60_000)
                      .max(24 * 60 * 60_000)
                      .optional(),
                    dispatchPaused: z.boolean().optional(),
                  })
                  .strict()
                  .refine((value) => Object.keys(value).length > 0),
              ),
            },
          },
          responses: {
            200: {
              description: "Profile updated; restrictions fence dispatch",
              ...json(Ok),
            },
            ...errors,
          },
        }),
        async (c) => {
          await service.updateProfile(
            c.get("owner").organizationId,
            c.req.valid("param").profileId,
            c.req.valid("json"),
          );
          return c.json({ ok: true as const }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/profiles/{profileId}/policies",
          request: {
            params: ProfileParams,
            body: { required: true, ...json(Rules) },
          },
          responses: {
            200: {
              description: "Explicit Profile policies replaced",
              ...json(Ok),
            },
            ...errors,
          },
        }),
        async (c) => {
          await service.setPolicies(
            c.get("owner").organizationId,
            c.req.valid("param").profileId,
            c.req.valid("json").rules,
          );
          return c.json({ ok: true as const }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/policies",
          request: { body: { required: true, ...json(Rules) } },
          responses: {
            200: {
              description: "Mandatory Workspace policies replaced",
              ...json(Ok),
            },
            ...errors,
          },
        }),
        async (c) => {
          await service.setPolicies(
            c.get("owner").organizationId,
            null,
            c.req.valid("json").rules,
          );
          return c.json({ ok: true as const }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "delete",
          path: "/grants/{grantId}",
          request: { params: GrantParams },
          responses: {
            200: {
              description: "Grant revoked; waiting work canceled",
              ...json(Ok),
            },
            ...errors,
          },
        }),
        async (c) => {
          await service.revokeGrant(
            c.get("owner").organizationId,
            c.req.valid("param").grantId,
          );
          return c.json({ ok: true as const }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/runs",
          responses: {
            200: {
              description: "Workspace Runs; protected payload excluded",
              ...json(z.array(Run)),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            (await service.ownerRuns(c.get("owner").organizationId)).map(
              ownerRunView,
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/runs/{runId}",
          request: { params: RunParams },
          responses: {
            200: { description: "Owner Run inspection", ...json(Run) },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            ownerRunView(
              await service.ownerRun(
                c.get("owner").organizationId,
                c.req.valid("param").runId,
              ),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/runs/{runId}/approve",
          request: { params: RunParams },
          responses: {
            200: {
              description: "Frozen request approved without extending deadline",
              ...json(Run),
            },
            ...errors,
          },
        }),
        async (c) => {
          const run = await service.decide(
            c.get("owner").organizationId,
            c.req.valid("param").runId,
            "approve",
          );
          await service.drain();
          return c.json(ownerRunView(run), 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/runs/{runId}/deny",
          request: { params: RunParams },
          responses: {
            200: {
              description: "Request denied without dispatch",
              ...json(Run),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            ownerRunView(
              await service.decide(
                c.get("owner").organizationId,
                c.req.valid("param").runId,
                "deny",
              ),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/runs/{runId}/cancel",
          request: { params: RunParams },
          responses: {
            200: {
              description:
                "Waiting work canceled; running cancellation best effort",
              ...json(Run),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            ownerRunView(
              await service.cancel(
                c.get("owner").organizationId,
                c.req.valid("param").runId,
              ),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/drain",
          responses: {
            200: {
              description:
                "Kick normal durable recovery without bypassing restrictions",
              ...json(Ok),
            },
            ...errors,
          },
        }),
        async (c) => {
          await service.drain();
          return c.json({ ok: true as const }, 200);
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/fixture",
          responses: {
            200: {
              description: "Observable fixture effects for this Workspace",
              ...json(z.object({ writes: z.number(), total: z.number() })),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await service.fixtureStats(c.get("owner").organizationId),
            200,
          ),
      );
    const integrationApi: IntegrationApi | undefined = integrations
      ? new IntegrationRoutes(integrations).api
      : undefined;
    this.api = integrationApi
      ? controlApi.route<
          "/",
          { Variables: { owner: Owner } },
          IntegrationApiSchema,
          "/"
        >("/", integrationApi)
      : controlApi;
  }
}

export type ControlApiType = ControlRoutes["api"];
