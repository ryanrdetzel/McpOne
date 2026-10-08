import type { Env } from "@scaffold/config";
import type { Database } from "@scaffold/database";
import { tables } from "@scaffold/schema";
import type { Auth, BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import {
  type DefaultOrganizationPlugin,
  type OrganizationOptions,
  organization,
} from "better-auth/plugins/organization";

export type AuthOptions = BetterAuthOptions & {
  plugins: [DefaultOrganizationPlugin<OrganizationOptions>];
};
export type Authentication = Auth<AuthOptions>;

/** Shared SQLite auth schema, with application-generated UUIDs on every platform. */
export function createAuth({
  env,
  db,
}: {
  env: Env;
  db: Database;
}): Authentication {
  const options: AuthOptions = {
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.TRUSTED_ORIGINS,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        users: tables.users,
        sessions: tables.sessions,
        accounts: tables.accounts,
        verifications: tables.verifications,
        organizations: tables.organizations,
        members: tables.members,
        invitations: tables.invitations,
      },
      usePlural: true,
    }),
    emailAndPassword: { enabled: true },
    plugins: [organization<OrganizationOptions>({})],
    telemetry: { enabled: false },
    advanced: {
      useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
      database: { generateId: () => crypto.randomUUID() },
    },
  };
  return betterAuth(options);
}
