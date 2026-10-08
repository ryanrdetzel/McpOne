import type { Database } from "@scaffold/database";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createOrgRoleGuard } from "../src/guard";

function guardApplication(
  session: {
    user: { id: string };
    session: { activeOrganizationId?: string | null };
  } | null,
  membership: { role: string }[] = [],
) {
  const getSession = vi.fn().mockResolvedValue(session);
  const where = vi.fn().mockResolvedValue(membership);
  const db = {
    select: () => ({ from: () => ({ where }) }),
  } as unknown as Database;
  const guard = createOrgRoleGuard({ api: { getSession } }, db);
  const app = new Hono();
  app.get("/", async (c) => {
    const actor = await guard(c, ["owner", "admin"]);
    return c.json(actor, actor.ok ? 200 : 403);
  });
  return { app, where, getSession };
}

describe("active organization role guard", () => {
  it("rejects absent sessions without querying memberships", async () => {
    const { app, where } = guardApplication(null);
    const response = await app.request("/");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(where).not.toHaveBeenCalled();
  });

  it("rejects sessions without an active organization", async () => {
    const { app, where } = guardApplication({
      user: { id: "user" },
      session: {},
    });
    const response = await app.request("/");
    expect(await response.json()).toEqual({
      ok: false,
      error: "no_active_organization",
    });
    expect(where).not.toHaveBeenCalled();
  });

  it.each([{ membership: [] }, { membership: [{ role: "member" }] }])(
    "rejects missing or insufficient active-org membership",
    async ({ membership }) => {
      const { app } = guardApplication(
        {
          user: { id: "user" },
          session: { activeOrganizationId: "active-org" },
        },
        membership,
      );
      const response = await app.request("/");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        ok: false,
        error: "insufficient_role",
      });
    },
  );

  it.each(["owner", "admin"])(
    "accepts %s only after checking the user and active org",
    async (role) => {
      const { app } = guardApplication(
        {
          user: { id: "user" },
          session: { activeOrganizationId: "active-org" },
        },
        [{ role }],
      );
      const response = await app.request("/", {
        headers: { cookie: "session=token" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        userId: "user",
        organizationId: "active-org",
      });
    },
  );
});
