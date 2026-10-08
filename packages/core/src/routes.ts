import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Env } from "@scaffold/config";
import { checkDatabase, type Database } from "@scaffold/database";
import {
  DashboardStatus,
  DatabaseStatus,
  FlagSet,
  Health,
  tables,
} from "@scaffold/schema";
import type { Context } from "hono";
import type { FlagService } from "./flags";
import type { OrgRoleResult } from "./guard";

export interface RouteDependencies {
  env: Env;
  db: Database;
  flags: FlagService;
  requireOrgRole(c: Context, roles: readonly string[]): Promise<OrgRoleResult>;
}

/** The instance property retains Hono's inferred RPC contract without a global app. */
export class ApiRoutes {
  readonly api;

  constructor({ env, db, flags, requireOrgRole }: RouteDependencies) {
    this.api = new OpenAPIHono()
      .openapi(
        createRoute({
          method: "get",
          path: "/healthz",
          responses: {
            200: {
              description: "Ready; current database schema available",
              content: { "application/json": { schema: Health } },
            },
            503: {
              description: "Database schema unavailable",
              content: { "application/json": { schema: Health } },
            },
          },
        }),
        async (c) => {
          try {
            await checkDatabase(db);
            return c.json({ ok: true, release: env.RELEASE }, 200);
          } catch {
            return c.json({ ok: false, release: env.RELEASE }, 503);
          }
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/db",
          responses: {
            200: {
              description: "Current database schema available",
              content: { "application/json": { schema: DatabaseStatus } },
            },
            503: {
              description: "Database unavailable",
              content: { "application/json": { schema: DatabaseStatus } },
            },
          },
        }),
        async (c) => {
          try {
            await checkDatabase(db);
            return c.json({ ok: true }, 200);
          } catch {
            return c.json({ ok: false }, 503);
          }
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/api/dashboard",
          responses: {
            200: {
              description: "Local scaffold status; database ready",
              content: { "application/json": { schema: DashboardStatus } },
            },
            503: {
              description: "Local scaffold status; database unavailable",
              content: { "application/json": { schema: DashboardStatus } },
            },
          },
        }),
        async (c) => {
          const status = { appSlug: env.APP_SLUG, release: env.RELEASE };
          try {
            await checkDatabase(db);
            return c.json({ ...status, database: true }, 200);
          } catch {
            return c.json({ ...status, database: false }, 503);
          }
        },
      )
      .openapi(
        createRoute({
          method: "put",
          path: "/admin/flags",
          request: {
            body: { content: { "application/json": { schema: FlagSet } } },
          },
          responses: {
            200: {
              description: "Flag set",
              content: { "application/json": { schema: FlagSet } },
            },
            403: {
              description: "Forbidden",
              content: {
                "application/json": { schema: z.object({ error: z.string() }) },
              },
            },
          },
        }),
        async (c) => {
          const actor = await requireOrgRole(c, ["owner", "admin"]);
          if (!actor.ok) return c.json({ error: actor.error }, 403);

          const input = c.req.valid("json");
          await db
            .insert(tables.featureFlags)
            .values(input)
            .onConflictDoUpdate({
              target: tables.featureFlags.key,
              set: { enabled: input.enabled, rolloutPct: input.rolloutPct },
            });
          flags.invalidateFlagCache();
          return c.json(input, 200);
        },
      );

    this.api.doc("/openapi.json", {
      openapi: "3.1.0",
      info: { title: `${env.APP_SLUG} api`, version: env.RELEASE },
    });
  }
}

/** Frontend uses hc<ApiType>("/").api.dashboard.$get(). */
export type ApiType = ApiRoutes["api"];
