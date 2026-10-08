import type { Database } from "@scaffold/database";
import { tables } from "@scaffold/schema";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

interface SessionReader {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string };
      session: { activeOrganizationId?: string | null };
    } | null>;
  };
}

export type OrgRoleResult =
  | { ok: true; userId: string; organizationId: string }
  | { ok: false; error: string };

/** A role is always relative to the session's active organization, never global. */
export function createOrgRoleGuard(auth: SessionReader, db: Database) {
  return async function requireOrgRole(
    c: Context,
    roles: readonly string[],
  ): Promise<OrgRoleResult> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return { ok: false, error: "unauthenticated" };

    const organizationId = session.session.activeOrganizationId;
    if (!organizationId) return { ok: false, error: "no_active_organization" };

    const [membership] = await db
      .select({ role: tables.members.role })
      .from(tables.members)
      .where(
        and(
          eq(tables.members.userId, session.user.id),
          eq(tables.members.organizationId, organizationId),
        ),
      );
    if (!membership || !roles.includes(membership.role)) {
      return { ok: false, error: "insufficient_role" };
    }
    return { ok: true, userId: session.user.id, organizationId };
  };
}
