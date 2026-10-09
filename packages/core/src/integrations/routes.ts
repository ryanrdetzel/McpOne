import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ExecutionError } from "@scaffold/schema/execution";
import {
  GatewayCreateConnectionInput,
  GatewayCreateProfileInput,
  GatewayState,
} from "@scaffold/schema/gateway";
import {
  AccountList,
  AccountView,
  ArtifactRef,
  ArtifactUploadQuery,
  CreateAccountInput,
  CreateIntegrationInput,
  IntegrationDraft,
  IntegrationView,
  OAuthStartInput,
  OAuthStartResult,
  PatchAccountInput,
  PatchIntegrationInput,
  ProfileRevision,
  ProfileView,
  Publication,
  PublishIntegrationInput,
  RefreshIntegrationInput,
  ReviewReportDocument,
  RollbackIntegrationInput,
  UpdateBindingsInput,
  ValidateIntegrationInput,
} from "@scaffold/schema/integrations";
import { ControlError } from "../execution/service";
import type { OrgRoleResult } from "../guard";
import type { AccountsService } from "./accounts";
import type { ArtifactService } from "./artifacts";
import type { CatalogService } from "./catalog";
import type { GatewayService } from "./gateway";
import type { OAuthService } from "./oauth";
export interface IntegrationOwnerServices {
  catalog: CatalogService;
  accounts: AccountsService;
  artifacts: ArtifactService;
  oauth: OAuthService;
  gateway?: GatewayService;
}
type Owner = Extract<OrgRoleResult, { ok: true }>;
const json = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});
const error = json(z.object({ error: ExecutionError }));
const errors = {
  400: { description: "Invalid request", ...error },
  401: { description: "Owner session required", ...error },
  403: { description: "Owner authority required", ...error },
  404: { description: "Resource unavailable", ...error },
  409: { description: "Current state conflicts", ...error },
  413: { description: "Byte limit exceeded", ...error },
  503: { description: "Provider prerequisite unavailable", ...error },
};
const IntegrationParams = z.object({ id: z.string().uuid() }),
  ProfileParams = z.object({ id: z.string().uuid() }),
  AccountParams = z.object({ id: z.string().uuid() });
/** Mounted inside ControlRoutes: the existing owner/origin middleware is the only administration authority. */
export class IntegrationRoutes {
  readonly api;

  constructor(services: IntegrationOwnerServices) {
    const api = new OpenAPIHono<{ Variables: { owner: Owner } }>({
      defaultHook: (result, c) => {
        if (!result.success)
          return c.json(
            {
              error: {
                code: "invalid_request",
                message: "Invalid bounded control request.",
                retryable: false,
              },
            },
            400,
          );
      },
    });
    const owner = (value: Owner) => ({
      orgId: value.organizationId,
      userId: value.userId,
    });
    const oauthOwner = (value: Owner) => {
      if (
        !("sessionId" in value) ||
        typeof value.sessionId !== "string" ||
        !value.sessionId
      )
        throw new ControlError(
          "unauthenticated",
          "An authenticated owner session is required.",
          401,
        );
      return { ...owner(value), sessionId: value.sessionId };
    };
    const gateway = () => {
      if (!services.gateway)
        throw new ControlError(
          "credential_unavailable",
          "Gateway services are unavailable.",
          503,
        );
      return services.gateway;
    };
    this.api = api
      .openapi(
        createRoute({
          method: "get",
          path: "/gateway",
          responses: {
            200: {
              description: "Workspace gateway configuration without secrets",
              ...json(GatewayState),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(await gateway().list(c.get("owner").organizationId), 200),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/gateway/profiles",
          request: {
            body: { required: true, ...json(GatewayCreateProfileInput) },
          },
          responses: {
            201: {
              description: "Empty workspace Profile",
              ...json(ProfileView),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await gateway().createProfile(
              owner(c.get("owner")),
              c.req.valid("json"),
            ),
            201,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/gateway/connections",
          request: {
            body: { required: true, ...json(GatewayCreateConnectionInput) },
          },
          responses: {
            201: {
              description: "Unpublished endpoint-bound connection draft",
              ...json(IntegrationDraft),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await gateway().createConnection(
              owner(c.get("owner")),
              c.req.valid("json"),
            ),
            201,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/integrations",
          request: {
            body: { required: true, ...json(CreateIntegrationInput) },
          },
          responses: {
            201: {
              description: "Unpublished source draft",
              ...json(IntegrationDraft),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.create(
              owner(c.get("owner")),
              c.req.valid("json"),
            ),
            201,
          ),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/integrations/{id}",
          request: { params: IntegrationParams },
          responses: {
            200: {
              description: "Owned catalogue revisions",
              ...json(IntegrationView),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.get(
              c.get("owner").organizationId,
              c.req.valid("param").id,
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/integrations/{id}/validate",
          request: {
            params: IntegrationParams,
            body: { required: true, ...json(ValidateIntegrationInput) },
          },
          responses: {
            200: {
              description:
                "Immutable source and current impact review; no business dispatch",
              ...json(ReviewReportDocument),
            },
            ...errors,
          },
        }),
        async (c) => {
          const report: ReviewReportDocument = await services.catalog.validate(
            owner(c.get("owner")),
            c.req.valid("param").id,
            c.req.valid("json").draftRevisionId,
          );
          return c.json(report, 200);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/integrations/{id}/refresh",
          request: {
            params: IntegrationParams,
            body: { required: true, ...json(RefreshIntegrationInput) },
          },
          responses: {
            201: {
              description: "Staged rediscovery draft",
              ...json(IntegrationDraft),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.refresh(
              owner(c.get("owner")),
              c.req.valid("param").id,
              c.req.valid("json"),
            ),
            201,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/integrations/{id}/publish",
          request: {
            params: IntegrationParams,
            body: { required: true, ...json(PublishIntegrationInput) },
          },
          responses: {
            200: {
              description:
                "Atomic reviewed publication and explicit Profile selections",
              ...json(Publication),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.publish(
              owner(c.get("owner")),
              c.req.valid("param").id,
              c.req.valid("json"),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/integrations/{id}/rollback",
          request: {
            params: IntegrationParams,
            body: { required: true, ...json(RollbackIntegrationInput) },
          },
          responses: {
            200: {
              description: "Atomic fresh-reviewed retained revision rollback",
              ...json(Publication),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.publish(
              owner(c.get("owner")),
              c.req.valid("param").id,
              c.req.valid("json"),
              true,
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/integrations/{id}",
          request: {
            params: IntegrationParams,
            body: { required: true, ...json(PatchIntegrationInput) },
          },
          responses: {
            200: {
              description:
                "Current restriction/display update, no draft activation",
              ...json(
                z.object({
                  integrationId: z.string().uuid(),
                  enabled: z.boolean(),
                  displayName: z.string(),
                }),
              ),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.patch(
              c.get("owner").organizationId,
              c.req.valid("param").id,
              c.req.valid("json"),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/profiles/{id}",
          request: { params: ProfileParams },
          responses: {
            200: {
              description: "Observed owner Profile revision and exact bindings",
              ...json(ProfileView),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.profile(
              c.get("owner").organizationId,
              c.req.valid("param").id,
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/profiles/{id}/bindings",
          request: {
            params: ProfileParams,
            body: { required: true, ...json(UpdateBindingsInput) },
          },
          responses: {
            200: {
              description: "Atomic explicit binding consent",
              ...json(ProfileRevision),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.catalog.updateBindings(
              owner(c.get("owner")),
              c.req.valid("param").id,
              c.req.valid("json"),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/accounts",
          request: { body: { required: true, ...json(CreateAccountInput) } },
          responses: {
            201: {
              description:
                "Verified native Provider Account, credential excluded",
              ...json(AccountView),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.accounts.createAccount(
              owner(c.get("owner")),
              c.req.valid("json"),
            ),
            201,
          ),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/accounts",
          responses: {
            200: {
              description: "Owned Account views, no credentials",
              ...json(AccountList),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.accounts.listAccounts(owner(c.get("owner"))),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/accounts/{id}",
          request: { params: AccountParams },
          responses: {
            200: { description: "Owned Account view", ...json(AccountView) },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.accounts.getAccount(
              owner(c.get("owner")),
              c.req.valid("param").id,
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "patch",
          path: "/accounts/{id}",
          request: {
            params: AccountParams,
            body: { required: true, ...json(PatchAccountInput) },
          },
          responses: {
            200: {
              description: "Same-identity rotation or current restriction",
              ...json(AccountView),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.accounts.updateAccount(
              owner(c.get("owner")),
              c.req.valid("param").id,
              c.req.valid("json"),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/accounts/oauth/start",
          request: { body: { required: true, ...json(OAuthStartInput) } },
          responses: {
            200: {
              description: "One-use owner/session consent intent",
              ...json(OAuthStartResult),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.oauth.startOAuth(
              oauthOwner(c.get("owner")),
              c.req.valid("json"),
            ),
            200,
          ),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/accounts/oauth/callback",
          request: {
            query: z
              .object({
                code: z.string().optional(),
                state: z.string().optional(),
                error: z.string().optional(),
              })
              .strict(),
          },
          responses: {
            303: { description: "Safe same-origin control-plane return" },
            ...errors,
          },
        }),
        async (c) => {
          const callbackUrl = new URL(c.req.url);
          callbackUrl.search = "";
          callbackUrl.hash = "";
          const result = await services.oauth.callback(
            oauthOwner(c.get("owner")),
            c.req.valid("query"),
            callbackUrl.href,
          );
          return c.redirect(result.returnPath, 303);
        },
      )
      .openapi(
        createRoute({
          method: "post",
          path: "/artifacts",
          request: {
            query: ArtifactUploadQuery,
            body: {
              required: true,
              content: {
                "application/octet-stream": {
                  schema: z.string().openapi({ format: "binary" }),
                },
              },
            },
          },
          responses: {
            201: {
              description: "Protected exact Grant/Profile staged input",
              ...json(ArtifactRef),
            },
            ...errors,
          },
        }),
        async (c) =>
          c.json(
            await services.artifacts.upload(
              { kind: "owner", ...owner(c.get("owner")) },
              {
                ...c.req.valid("query"),
                body: c.req.raw.body,
                mediaType:
                  c.req.header("Content-Type") ?? "application/octet-stream",
                filename: c.req.header("X-Artifact-Filename"),
                contentEncoding: c.req.header("Content-Encoding"),
                contentLength: c.req.header("Content-Length"),
              },
            ),
            201,
          ),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/artifacts/{id}",
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: {
              description: "Authenticated binary attachment",
              content: {
                "application/octet-stream": {
                  schema: z.string().openapi({ format: "binary" }),
                },
              },
            },
            410: {
              description: "Authorized protected content expired",
              ...error,
            },
            416: { description: "Range unsupported", ...error },
            ...errors,
          },
        }),
        async (c) =>
          services.artifacts.download(
            { kind: "owner", ...owner(c.get("owner")) },
            c.req.valid("param").id,
            {
              method: c.req.method === "HEAD" ? "HEAD" : "GET",
              range: c.req.header("Range"),
            },
          ),
      );
  }
}

/** Named owner API boundary; flatten route intersections without erasing their inputs or outputs. */
export type IntegrationApiSchema =
  IntegrationRoutes["api"] extends OpenAPIHono<
    { Variables: { owner: Owner } },
    infer Routes
  >
    ? { [Path in keyof Routes]: Routes[Path] }
    : never;
export type IntegrationApi = OpenAPIHono<
  { Variables: { owner: Owner } },
  IntegrationApiSchema
>;
