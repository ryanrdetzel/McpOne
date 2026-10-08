import { readdirSync, readFileSync } from "node:fs";
import {
  createExecutionService,
  type ExecutionService,
  type GrantIdentity,
} from "@scaffold/core/execution";
import { createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import { IDEMPOTENCY_RETENTION_MS } from "@scaffold/schema/execution";
import { describe, expect, it } from "vitest";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ORG = "execution-regression-org";
const migrations = new URL(
  "../../../packages/database/migrations/",
  import.meta.url,
);

interface ExecutionFixture {
  binding: SQLiteBinding;
  clock: { value: number };
  service: ExecutionService;
  profileId: string;
  grant: GrantIdentity;
  request: (
    key: string,
    value?: number,
  ) => {
    name: string;
    arguments: { value: number };
    metadata: { idempotency_key: string };
  };
}

async function withExecution(
  run: (fixture: ExecutionFixture) => Promise<void>,
) {
  const binding = new SQLiteBinding(":memory:");
  try {
    await run(await seedExecution(binding));
  } finally {
    binding.close();
  }
}

async function seedExecution(
  binding: SQLiteBinding,
): Promise<ExecutionFixture> {
  for (const name of readdirSync(migrations)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()) {
    await binding.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  await binding
    .prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
    .bind(ORG, "Execution regressions", "execution-regressions")
    .run();
  // A local logical clock is ahead of SQLite wall time, never a public API bypass.
  const clock = { value: Date.now() + HOUR };
  const service = createExecutionService({
    db: createDatabase(binding),
    secret: "local-in-memory-execution-regressions-protection-key",
    now: () => clock.value,
  });
  const { profileId, tool } = await service.setup(ORG, "Regression profile");
  const issued = await service.issueGrant(ORG, profileId, "Regression grant");
  const grant = await service.authenticate(profileId, issued.token);
  await service.setPolicies(ORG, profileId, [
    { pattern: tool, decision: "allow" },
  ]);
  const request = (key: string, value = 1) => ({
    name: tool,
    arguments: { value },
    metadata: { idempotency_key: key },
  });
  return { binding, clock, service, profileId, grant, request };
}

async function reservation(binding: SQLiteBinding, runId: string) {
  return binding
    .prepare(
      `SELECT r.created_at,r.updated_at,r.deadline,d.expires_at AS dedup_expires_at,
        p.expires_at AS payload_expires_at
      FROM control_runs r JOIN control_dedup d ON d.run_id=r.id
      JOIN control_run_payloads p ON p.run_id=r.id WHERE r.id=?`,
    )
    .bind(runId)
    .first<{
      created_at: number;
      updated_at: number;
      deadline: number | null;
      dedup_expires_at: number;
      payload_expires_at: number;
    }>();
}

describe("durable execution admission on real SQLite", () => {
  it("reserves an initial disabled-membership denial through enable and redelivery", () =>
    withExecution(async ({ binding, service, profileId, grant, request }) => {
      await service.updateProfile(ORG, profileId, { toolEnabled: false });
      const input = request("initially-disabled", 7);
      const denied = await service.invoke(grant, input);
      expect(denied).toMatchObject({
        status: "blocked",
        error: { code: "tool_unavailable" },
      });
      const duplicates = await Promise.all([
        service.invoke(grant, input),
        service.invoke(grant, input),
      ]);
      expect(duplicates.map((run) => run.runId)).toEqual([
        denied.runId,
        denied.runId,
      ]);
      await expect(
        service.invoke(grant, request("initially-disabled", 8)),
      ).rejects.toMatchObject({
        code: "idempotency_conflict",
        runId: denied.runId,
      });
      const stored = await reservation(binding, denied.runId);
      expect(stored?.dedup_expires_at).toBe(
        denied.createdAt + IDEMPOTENCY_RETENTION_MS,
      );
      await service.updateProfile(ORG, profileId, { toolEnabled: true });
      expect(await service.invoke(grant, input)).toMatchObject({
        runId: denied.runId,
        status: "blocked",
        error: { code: "tool_unavailable" },
      });
      expect(await reservation(binding, denied.runId)).toEqual(stored);
      await service.drain();
      expect(await service.fixtureStats(ORG)).toEqual({ writes: 0, total: 0 });
      expect(await service.ownerRuns(ORG)).toHaveLength(1);
    }));

  it("returns an existing Run while membership is disabled and conflicts without another effect", () =>
    withExecution(async ({ binding, service, profileId, grant, request }) => {
      const input = request("disabled-redelivery", 5);
      const original = await service.invoke(grant, input);
      await service.drain();
      expect(await service.getRun(grant, original.runId)).toMatchObject({
        status: "succeeded",
        result: { incremented: 5 },
      });
      const stored = await reservation(binding, original.runId);
      await service.updateProfile(ORG, profileId, { toolEnabled: false });
      expect(await service.invoke(grant, input)).toMatchObject({
        runId: original.runId,
        status: "succeeded",
        result: { incremented: 5 },
      });
      await expect(
        service.invoke(grant, request("disabled-redelivery", 6)),
      ).rejects.toMatchObject({
        code: "idempotency_conflict",
        runId: original.runId,
      });
      expect(
        await binding
          .prepare(
            "SELECT run_id FROM control_audit WHERE action='idempotency_conflict'",
          )
          .all(),
      ).toMatchObject({ results: [{ run_id: original.runId }] });
      await service.updateProfile(ORG, profileId, { toolEnabled: true });
      expect((await service.invoke(grant, input)).runId).toBe(original.runId);
      expect(await reservation(binding, original.runId)).toEqual(stored);
      await service.drain();
      expect(await service.fixtureStats(ORG)).toEqual({ writes: 1, total: 5 });
      expect(await service.ownerRuns(ORG)).toHaveLength(1);
    }));

  it("retains the key for seven full days after delayed admission, not invocation start", () =>
    withExecution(async ({ binding, clock, service, grant, request }) => {
      const input = request("delayed-admission", 3);
      const startedAt = clock.value;
      const pending = service.invoke(grant, input);
      // invoke has yielded at its real database read; admission has not occurred.
      clock.value += DAY;
      const original = await pending;
      const admittedAt = clock.value;
      expect(original.createdAt).toBe(admittedAt);
      expect(await reservation(binding, original.runId)).toEqual({
        created_at: admittedAt,
        updated_at: admittedAt,
        deadline: null,
        dedup_expires_at: admittedAt + IDEMPOTENCY_RETENTION_MS,
        payload_expires_at: admittedAt + IDEMPOTENCY_RETENTION_MS,
      });
      await service.drain();
      clock.value = startedAt + IDEMPOTENCY_RETENTION_MS;
      expect(await service.invoke(grant, input)).toMatchObject({
        runId: original.runId,
        status: "succeeded",
        result: { incremented: 3 },
      });
      clock.value = admittedAt + IDEMPOTENCY_RETENTION_MS - 1;
      expect((await service.invoke(grant, input)).runId).toBe(original.runId);
      await service.drain();
      expect(await service.fixtureStats(ORG)).toEqual({ writes: 1, total: 3 });
      clock.value = admittedAt + IDEMPOTENCY_RETENTION_MS;
      const replacement = await service.invoke(grant, input);
      expect(replacement.runId).not.toBe(original.runId);
      expect(replacement.status).toBe("queued");
      expect(
        (await reservation(binding, replacement.runId))?.dedup_expires_at,
      ).toBe(clock.value + IDEMPOTENCY_RETENTION_MS);
      await service.drain();
      expect(await service.fixtureStats(ORG)).toEqual({ writes: 2, total: 6 });
      expect(await service.ownerRuns(ORG)).toHaveLength(2);
    }));

  it("freezes Ask deadlines and protected retention from delayed admission before approval", () =>
    withExecution(
      async ({ binding, clock, service, profileId, grant, request }) => {
        const lifetime = 15 * 60 * 1000;
        await service.updateProfile(ORG, profileId, {
          approvalLifetimeMs: lifetime,
        });
        const input = request("delayed-ask", 4);
        await service.setPolicies(ORG, profileId, [
          { pattern: input.name, decision: "ask" },
        ]);
        const pending = service.invoke(grant, input);
        clock.value += DAY;
        const original = await pending;
        expect(original).toMatchObject({
          status: "pending_approval",
          createdAt: clock.value,
          deadline: clock.value + lifetime,
        });
        const stored = await reservation(binding, original.runId);
        expect(stored).toMatchObject({
          created_at: original.createdAt,
          deadline: original.deadline,
          dedup_expires_at: original.createdAt + IDEMPOTENCY_RETENTION_MS,
          payload_expires_at: original.createdAt + IDEMPOTENCY_RETENTION_MS,
        });
        expect(
          await binding
            .prepare(
              "SELECT deadline,created_at FROM control_approvals WHERE run_id=?",
            )
            .bind(original.runId)
            .first(),
        ).toEqual({
          deadline: original.deadline,
          created_at: original.createdAt,
        });
        await service.updateProfile(ORG, profileId, {
          approvalLifetimeMs: DAY,
        });
        clock.value = original.createdAt + lifetime - 1;
        expect(await service.invoke(grant, input)).toMatchObject({
          runId: original.runId,
          deadline: original.deadline,
          status: "pending_approval",
        });
        expect(await reservation(binding, original.runId)).toEqual(stored);
        await expect(
          binding
            .prepare("UPDATE control_runs SET deadline=deadline+1 WHERE id=?")
            .bind(original.runId)
            .run(),
        ).rejects.toThrow("Run requests and deadlines are immutable");
        await service.decide(ORG, original.runId, "approve");
        await service.drain();
        expect(await service.fixtureStats(ORG)).toEqual({
          writes: 1,
          total: 4,
        });
      },
    ));

  it("uses the database clock floor for immutable admission and approval timestamps", () =>
    withExecution(
      async ({ binding, clock, service, profileId, grant, request }) => {
        const input = request("database-clock-floor");
        await service.setPolicies(ORG, profileId, [
          { pattern: input.name, decision: "ask" },
        ]);
        const before = await binding
          .prepare(
            "SELECT cast((julianday('now') - 2440587.5) * 86400000 as integer) AS at",
          )
          .first<{ at: number }>();
        clock.value = 1;
        const original = await service.invoke(grant, input);
        expect(original.createdAt).toBeGreaterThanOrEqual(before!.at);
        expect(original.deadline).toBe(original.createdAt + 3 * HOUR);
        expect(await reservation(binding, original.runId)).toEqual({
          created_at: original.createdAt,
          updated_at: original.createdAt,
          deadline: original.deadline,
          dedup_expires_at: original.createdAt + IDEMPOTENCY_RETENTION_MS,
          payload_expires_at: original.createdAt + IDEMPOTENCY_RETENTION_MS,
        });
        expect(await service.fixtureStats(ORG)).toEqual({
          writes: 0,
          total: 0,
        });
      },
    ));

  it("does not let disabled-membership deduplication authorize revoked or expired Grant retrieval", () =>
    withExecution(async ({ clock, service, profileId, grant, request }) => {
      const original = await service.invoke(
        grant,
        request("retrieval-authority"),
      );
      await service.updateProfile(ORG, profileId, { toolEnabled: false });
      await service.revokeGrant(ORG, grant.id);
      await expect(service.getRun(grant, original.runId)).rejects.toMatchObject(
        {
          code: "grant_revoked",
        },
      );
      const expiring = await service.issueGrant(
        ORG,
        profileId,
        "Expiring regression grant",
        clock.value + HOUR,
      );
      const expiringGrant = await service.authenticate(
        profileId,
        expiring.token,
      );
      const denied = await service.invoke(
        expiringGrant,
        request("expired-retrieval"),
      );
      expect(denied.error?.code).toBe("tool_unavailable");
      clock.value += HOUR;
      await expect(
        service.getRun(expiringGrant, denied.runId),
      ).rejects.toMatchObject({
        code: "grant_expired",
      });
      expect(await service.fixtureStats(ORG)).toEqual({ writes: 0, total: 0 });
    }));
});
