import { readdirSync, readFileSync } from "node:fs";
import { parseEnv } from "@scaffold/config";
import type { GrantIdentity } from "@scaffold/core/execution";
import { createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import {
  EXECUTION_FALLBACK_PREFIX,
  EXECUTION_META_NAMESPACE,
  IDEMPOTENCY_RETENTION_MS,
  MCP_PROTOCOL_VERSION,
  RunControl,
} from "@scaffold/schema/execution";
import type { Source, ToolDefinition } from "@scaffold/schema/integrations";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256,
} from "../../../packages/core/src/execution/canonical";
import { toolResult } from "../../../packages/core/src/execution/presentation";
import { createPayloadProtection } from "../../../packages/core/src/execution/protection";
import { createGithubProvider } from "../../../packages/core/src/integrations/providers/github";
import {
  createIntegrationServices,
  type IntegrationServices,
} from "../../../packages/core/src/integrations/runtime";
import { createQuickJSEngineFactory } from "../../../packages/core/src/integrations/sandbox";
import { createMcpRoutes } from "../../../packages/core/src/mcp";
import { createLocalHttpTransport } from "../src/transport";

const ORG = "m2-authoring-org",
  USER = "m2-authoring-owner",
  HOUR = 3600000;
const SECRET = "local-m2-authoring-real-sqlite-protection-key";
const migrations = new URL(
  "../../../packages/database/migrations/",
  import.meta.url,
);
interface Fixture {
  binding: SQLiteBinding;
  services: IntegrationServices;
  profileId: string;
  grant: GrantIdentity;
  token: string;
  clock: { value: number };
}
async function withAuthoring(run: (fixture: Fixture) => Promise<void>) {
  const binding = new SQLiteBinding(":memory:");
  try {
    for (const name of readdirSync(migrations)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort())
      await binding.exec(readFileSync(new URL(name, migrations), "utf8"));
    await binding
      .prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
      .bind(ORG, "Authoring regressions", "m2-authoring")
      .run();
    await binding
      .prepare("INSERT INTO users(id,name,email) VALUES(?,?,?)")
      .bind(USER, "Authoring owner", "authoring@example.test")
      .run();
    await binding
      .prepare(
        "INSERT INTO members(id,organization_id,user_id,role) VALUES(?,?,?,'owner')",
      )
      .bind("m2-authoring-member", ORG, USER)
      .run();
    const clock = { value: Date.now() + HOUR },
      transport = createLocalHttpTransport();
    const services = createIntegrationServices({
      db: createDatabase(binding),
      secret: SECRET,
      transport,
      providers: [createGithubProvider({ transport, now: () => clock.value })],
      engineFactory: createQuickJSEngineFactory(),
      now: () => clock.value,
    });
    const { profileId } = await services.execution.setup(
      ORG,
      "Selected profile",
    );
    const { token } = await services.execution.issueGrant(
      ORG,
      profileId,
      "Authoring grant",
      undefined,
      USER,
    );
    const grant = await services.execution.authenticate(profileId, token);
    await services.execution.setPolicies(ORG, profileId, [
      { pattern: "fixture.counter.increment", decision: "allow" },
    ]);
    await run({ binding, services, profileId, grant, token, clock });
  } finally {
    binding.close();
  }
}
const owner = { orgId: ORG, userId: USER };
function authored(slug = "math", offset = 0): Source {
  const tool: ToolDefinition = {
    name: `${slug}.echo`,
    description: "Reviewed immutable arithmetic",
    operationClass: "read",
    requirements: {},
    permissions: [],
    inputSchema: {
      type: "object",
      properties: { value: { type: "integer", default: "invalid annotation" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { echoed: { type: "integer" } },
      required: ["echoed"],
      additionalProperties: false,
    },
    implementation: {
      kind: "typescript",
      source:
        'import {delta} from "./constants.ts"; export default function run(input:{value:number}) {console.log("entered",input.value);return {echoed:input.value+delta};}',
      entrypoint: "default",
      modules: { "constants.ts": `export const delta=${offset};` },
    },
  };
  return { kind: "typescript", tools: [tool] };
}
async function publish(
  f: Fixture,
  integrationId: string,
  draftRevisionId: string,
  decision: "allow" | "ask" = "allow",
) {
  const report = await f.services.catalog.validate(
    owner,
    integrationId,
    draftRevisionId,
  );
  const integration = await f.services.catalog.get(ORG, integrationId),
    profile = await f.services.catalog.profile(ORG, f.profileId);
  return f.services.catalog.publish(owner, integrationId, {
    draftRevisionId,
    reportDigest: report.reportDigest,
    expectedCurrentRevisionId: integration.currentRevisionId,
    profiles: [
      {
        profileId: f.profileId,
        expectedRevision: profile.revision,
        tools: report.accepted.map((tool) => tool.name),
        bindings: {},
        policies: report.accepted.map((tool) => ({
          pattern: tool.name,
          decision,
        })),
      },
    ],
  });
}
const request = (key: string, name = "math.echo", value = 4) => ({
  name,
  arguments: { value },
  metadata: { idempotency_key: key },
});

// These tests use actual SQLite transactions, compiler/WASM and composition. They do not claim Provider or hosted-platform proof.
describe("M2 owner authoring and the single durable execution engine", () => {
  it("keeps drafts inert, exposes only selected Profiles, retains schema warnings and protects owner-only guest logs", () =>
    withAuthoring(async (f) => {
      const unselected = await f.services.execution.setup(
        ORG,
        "Unselected profile",
      );
      const unselectedToken = await f.services.execution.issueGrant(
        ORG,
        unselected.profileId,
        "Unselected grant",
        undefined,
        USER,
      );
      const unselectedGrant = await f.services.execution.authenticate(
        unselected.profileId,
        unselectedToken.token,
      );
      const source = authored(),
        created = await f.services.catalog.create(owner, {
          slug: "math",
          displayName: "Math",
          source,
        });
      expect(
        (await f.services.execution.discover(f.grant)).some(
          (tool) => tool.name === "math.echo",
        ),
      ).toBe(false);
      const report = await f.services.catalog.validate(
        owner,
        created.integrationId,
        created.draftRevisionId,
      );
      expect(report.accepted).toHaveLength(1);
      expect(report.rejected).toEqual([]);
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "schema_warning",
            path: expect.stringContaining("/default"),
          }),
        ]),
      );
      expect(await f.services.execution.fixtureStats(ORG)).toEqual({
        writes: 0,
        total: 0,
      });
      const rejected = await f.services.execution.invoke(
        f.grant,
        request("draft-is-inert"),
      );
      expect(rejected.status).toBe("blocked");
      expect(rejected.error?.code).toBe("tool_unavailable");
      expect(
        await f.binding
          .prepare(
            "SELECT count(*) AS count FROM control_attempts WHERE run_id=?",
          )
          .bind(rejected.runId)
          .first("count"),
      ).toBe(0);
      await publish(f, created.integrationId, created.draftRevisionId);
      expect(
        (await f.services.execution.discover(unselectedGrant)).some(
          (tool) => tool.name === "math.echo",
        ),
      ).toBe(false);
      expect(
        (await f.services.catalog.profile(ORG, f.profileId)).tools,
      ).toEqual(["fixture.counter.increment", "math.echo"]);
      const queued = await f.services.execution.invoke(
        f.grant,
        request("actual-compiled-run"),
      );
      expect(queued.status).toBe("queued");
      await f.services.execution.drain();
      const finished = await f.services.execution.getRun(f.grant, queued.runId);
      expect(finished).toMatchObject({
        status: "succeeded",
        businessResult: { structuredContent: { echoed: 4 } },
      });
      expect(finished).not.toHaveProperty("logs");
      expect(finished).not.toHaveProperty("outboundRequests");
      expect(finished).not.toHaveProperty("effectState");
      const inspected = await f.services.execution.ownerRun(ORG, queued.runId);
      expect(inspected).toMatchObject({
        outboundRequests: 0,
        effectState: "not_dispatched",
        logs: [
          expect.objectContaining({
            level: "log",
            text: expect.stringContaining("entered"),
          }),
        ],
      });
      const encrypted = await f.binding
        .prepare(
          "SELECT cipher,expires_at FROM control_run_log_chunks WHERE run_id=?",
        )
        .bind(queued.runId)
        .first<{ cipher: string; expires_at: number }>();
      expect(encrypted?.cipher).not.toContain("entered");
      expect(encrypted?.expires_at).toBe(
        queued.createdAt + IDEMPOTENCY_RETENTION_MS,
      );
      expect(JSON.stringify(toolResult(finished))).not.toContain("entered");
      expect(
        (
          await f.binding
            .prepare(
              "SELECT source_digest FROM control_integration_revisions WHERE id=?",
            )
            .bind(created.draftRevisionId)
            .first<{ source_digest: string }>()
        )?.source_digest,
      ).toBe(await sha256(canonicalJson(source)));
      f.clock.value = queued.createdAt + IDEMPOTENCY_RETENTION_MS;
      await f.services.execution.drain();
      expect(
        (await f.services.execution.ownerRun(ORG, queued.runId)).logs,
      ).toEqual([]);
      expect(
        await f.binding
          .prepare(
            "SELECT count(*) AS count FROM control_run_log_chunks WHERE run_id=?",
          )
          .bind(queued.runId)
          .first("count"),
      ).toBe(0);
    }));

  it("makes publication CAS atomic and keeps approved pending requests pinned across publication and rollback", () =>
    withAuthoring(async (f) => {
      const created = await f.services.catalog.create(owner, {
        slug: "math",
        displayName: "Math",
        source: authored(),
      });
      const stale = await f.services.catalog.validate(
          owner,
          created.integrationId,
          created.draftRevisionId,
        ),
        profile = await f.services.catalog.profile(ORG, f.profileId);
      await f.services.execution.setPolicies(ORG, f.profileId, [
        { pattern: "fixture.counter.increment", decision: "allow" },
        { pattern: "unrelated.*", decision: "block" },
      ]);
      await expect(
        f.services.catalog.publish(owner, created.integrationId, {
          draftRevisionId: created.draftRevisionId,
          reportDigest: stale.reportDigest,
          expectedCurrentRevisionId: null,
          profiles: [
            {
              profileId: f.profileId,
              expectedRevision: profile.revision,
              tools: ["math.echo"],
              bindings: {},
              policies: [{ pattern: "math.echo", decision: "ask" }],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "publication_conflict" });
      expect(
        (await f.services.catalog.get(ORG, created.integrationId))
          .currentRevisionId,
      ).toBeNull();
      expect(
        (await f.services.catalog.profile(ORG, f.profileId)).revision,
      ).toBe(profile.revision);
      await publish(f, created.integrationId, created.draftRevisionId, "ask");
      await f.services.execution.updateProfile(ORG, f.profileId, {
        dispatchPaused: true,
      });
      const input = request("retained-request"),
        pending = await f.services.execution.invoke(f.grant, input);
      expect(pending.status).toBe("pending_approval");
      const original = await f.binding
        .prepare(
          "SELECT r.created_at,r.deadline,r.tool_revision,r.integration_revision_id,r.artifact_digest,r.fingerprint,r.policy_decision,d.expires_at,p.expires_at AS payload_expires_at,p.request_chunk_count FROM control_runs r JOIN control_dedup d ON d.run_id=r.id JOIN control_run_payloads p ON p.run_id=r.id WHERE r.id=?",
        )
        .bind(pending.runId)
        .first();
      const next = await f.services.catalog.refresh(
        owner,
        created.integrationId,
        { source: authored("math", 20) },
      );
      await publish(f, created.integrationId, next.draftRevisionId, "allow");
      expect(
        await f.services.catalog.resolveTool(ORG, f.profileId, input.name),
      ).toMatchObject({
        tool: {
          toolRevision: next.draftRevisionId,
          integrationRevision: next.draftRevisionId,
        },
      });
      const mcp = createMcpRoutes(
          f.services.execution,
          parseEnv({ NODE_ENV: "test" }),
        ),
        response = await mcp.request(`/${f.profileId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${f.token}`,
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "changed-revision",
            method: "tools/call",
            params: {
              name: input.name,
              arguments: input.arguments,
              _meta: { [EXECUTION_META_NAMESPACE]: input.metadata },
            },
          }),
        });
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(receipt).toMatchObject({
        jsonrpc: "2.0",
        id: "changed-revision",
        result: { isError: true },
      });
      expect(receipt).not.toHaveProperty("error");
      expect(receipt.result).not.toHaveProperty("structuredContent");
      expect(receipt.result.content).toHaveLength(1);
      expect(receipt.result._meta).toEqual({
        [EXECUTION_META_NAMESPACE]: {
          run_id: pending.runId,
          tool: input.name,
        },
      });
      const fallback = receipt.result.content[0];
      expect(fallback.type).toBe("text");
      expect(fallback.text.startsWith(EXECUTION_FALLBACK_PREFIX)).toBe(true);
      expect(
        RunControl.parse(
          JSON.parse(fallback.text.slice(EXECUTION_FALLBACK_PREFIX.length)),
        ),
      ).toMatchObject({
        run_id: pending.runId,
        tool: input.name,
        status: "pending_approval",
        approval_url: pending.approvalLink,
        error: {
          code: "idempotency_conflict",
          retryable: false,
          run_id: pending.runId,
        },
      });
      expect(
        await f.services.execution.getRun(f.grant, pending.runId),
      ).toMatchObject({
        status: "pending_approval",
        deadline: pending.deadline,
        approvalLink: pending.approvalLink,
      });
      expect(
        await f.services.execution.getRun(f.grant, pending.runId),
      ).not.toHaveProperty("error");
      expect(
        await f.binding
          .prepare(
            "SELECT count(*) AS count FROM control_runs WHERE grant_id=? AND tool=?",
          )
          .bind(f.grant.id, input.name)
          .first("count"),
      ).toBe(1);
      expect(
        await f.binding
          .prepare(
            "SELECT count(*) AS count FROM control_attempts WHERE run_id=?",
          )
          .bind(pending.runId)
          .first("count"),
      ).toBe(0);
      expect(
        await f.binding
          .prepare(
            "SELECT run_id FROM control_audit WHERE action='idempotency_conflict'",
          )
          .first("run_id"),
      ).toBe(pending.runId);
      await f.services.execution.decide(ORG, pending.runId, "approve");
      await f.services.execution.updateProfile(ORG, f.profileId, {
        dispatchPaused: false,
      });
      await f.services.execution.drain();
      expect(
        await f.services.execution.getRun(f.grant, pending.runId),
      ).toMatchObject({
        status: "succeeded",
        businessResult: { structuredContent: { echoed: 4 } },
      });
      expect(
        await f.binding
          .prepare(
            "SELECT revision FROM control_tool_revisions WHERE tool_id=(SELECT tool_id FROM control_runs WHERE id=?) AND revision=?",
          )
          .bind(pending.runId, created.draftRevisionId)
          .first(),
      ).not.toBeNull();
      expect(
        await f.binding
          .prepare(
            "SELECT r.created_at,r.deadline,r.tool_revision,r.integration_revision_id,r.artifact_digest,r.fingerprint,r.policy_decision,d.expires_at,p.expires_at AS payload_expires_at,p.request_chunk_count FROM control_runs r JOIN control_dedup d ON d.run_id=r.id JOIN control_run_payloads p ON p.run_id=r.id WHERE r.id=?",
          )
          .bind(pending.runId)
          .first(),
      ).toEqual(original);
      await expect(
        f.services.execution.invoke(f.grant, input),
      ).rejects.toMatchObject({
        code: "idempotency_conflict",
        runId: pending.runId,
      });
      const changed = await f.services.execution.invoke(
        f.grant,
        request("changed-revision-new-key"),
      );
      await f.services.execution.drain();
      expect(
        await f.services.execution.getRun(f.grant, changed.runId),
      ).toMatchObject({
        status: "succeeded",
        businessResult: { structuredContent: { echoed: 24 } },
      });
      const oldReview = await f.services.catalog.validate(
          owner,
          created.integrationId,
          created.draftRevisionId,
        ),
        current = await f.services.catalog.profile(ORG, f.profileId);
      await f.services.catalog.publish(
        owner,
        created.integrationId,
        {
          revisionId: created.draftRevisionId,
          reportDigest: oldReview.reportDigest,
          expectedCurrentRevisionId: next.draftRevisionId,
          profiles: [
            {
              profileId: f.profileId,
              expectedRevision: current.revision,
              tools: ["math.echo"],
              bindings: {},
              policies: [{ pattern: "math.echo", decision: "allow" }],
            },
          ],
        },
        true,
      );
      const replay = await f.services.execution.invoke(f.grant, input);
      expect(replay.runId).toBe(pending.runId);
      const newRun = await f.services.execution.invoke(
        f.grant,
        request("after-rollback"),
      );
      await f.services.execution.drain();
      expect(
        await f.services.execution.getRun(f.grant, newRun.runId),
      ).toMatchObject({
        status: "succeeded",
        businessResult: { structuredContent: { echoed: 4 } },
      });
      expect(
        await f.binding
          .prepare(
            "SELECT decision FROM control_policies WHERE profile_id=? AND pattern='unrelated.*'",
          )
          .bind(f.profileId)
          .first("decision"),
      ).toBe("block");
      expect(
        (await f.services.catalog.profile(ORG, f.profileId)).tools,
      ).toContain("fixture.counter.increment");
    }));

  it("checks native membership independently of workspace epoch without breaking legacy null-principal fixture Grants", () =>
    withAuthoring(async (f) => {
      const created = await f.services.catalog.create(owner, {
        slug: "math",
        displayName: "Math",
        source: authored(),
      });
      await publish(f, created.integrationId, created.draftRevisionId);
      const queued = await f.services.execution.invoke(
        f.grant,
        request("membership-loss"),
      );
      const legacy = await f.services.execution.issueGrant(
          ORG,
          f.profileId,
          "Retained legacy null principal",
        ),
        oldGrant = await f.services.execution.authenticate(
          f.profileId,
          legacy.token,
        );
      const epoch = await f.binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(ORG)
        .first("epoch");
      await f.binding
        .prepare(
          "UPDATE members SET role='member' WHERE organization_id=? AND user_id=?",
        )
        .bind(ORG, USER)
        .run();
      expect(
        (await f.services.execution.authenticate(f.profileId, f.token)).id,
      ).toBe(f.grant.id);
      await f.binding
        .prepare("DELETE FROM members WHERE organization_id=? AND user_id=?")
        .bind(ORG, USER)
        .run();
      expect(
        await f.binding
          .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
          .bind(ORG)
          .first("epoch"),
      ).toBe(epoch);
      await expect(
        f.services.execution.authenticate(f.profileId, f.token),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        f.services.execution.getRun(f.grant, queued.runId),
      ).rejects.toMatchObject({ code: "forbidden" });
      await f.services.execution.drain();
      expect(
        await f.services.execution.ownerRun(ORG, queued.runId),
      ).toMatchObject({ status: "blocked", outboundRequests: 0, logs: [] });
      expect(
        await f.binding
          .prepare(
            "SELECT count(*) AS count FROM control_attempts WHERE run_id=?",
          )
          .bind(queued.runId)
          .first("count"),
      ).toBe(0);
      const fixtureRun = await f.services.execution.invoke(oldGrant, {
        name: "fixture.counter.increment",
        arguments: { value: 3 },
        metadata: { idempotency_key: "legacy-still-works" },
      });
      await f.services.execution.drain();
      expect(
        await f.services.execution.getRun(oldGrant, fixtureRun.runId),
      ).toMatchObject({ status: "succeeded", result: { incremented: 3 } });
    }));

  it("uses explicit stored result format, not business object shape, for historical M1 projection", () =>
    withAuthoring(async (f) => {
      const fixtureRun = await f.services.execution.invoke(f.grant, {
        name: "fixture.counter.increment",
        arguments: { value: 1 },
        metadata: { idempotency_key: "legacy-business-shape" },
      });
      await f.services.execution.drain();
      const historical = {
          format: "mcp",
          result: { business: "ordinary legacy JSON" },
        },
        cipher = await createPayloadProtection(SECRET).encrypt(
          ORG,
          fixtureRun.runId,
          "result",
          historical,
        );
      await f.binding
        .prepare(
          "UPDATE control_run_payloads SET result_format='legacy_json',result_cipher=? WHERE run_id=?",
        )
        .bind(cipher, fixtureRun.runId)
        .run();
      expect(
        await f.services.execution.getRun(f.grant, fixtureRun.runId),
      ).toMatchObject({
        status: "succeeded",
        result: historical,
        businessResult: { structuredContent: historical },
      });
      expect(
        await f.services.execution.ownerRun(ORG, fixtureRun.runId),
      ).not.toHaveProperty("logs");
    }));

  it("validates complete presentation bytes before terminal success using the actual MCP renderer and maximum escaped ID", () =>
    withAuthoring(async (f) => {
      const source = authored("edge"),
        tool = source.kind === "typescript" ? source.tools[0]! : undefined;
      if (!tool || tool.implementation.kind !== "typescript")
        throw new Error("Unexpected authored test source");
      tool.inputSchema = {
        $defs: {
          arguments: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        $ref: "#/$defs/arguments",
      };
      tool.outputSchema = {
        type: "object",
        properties: { data: { type: "string" } },
        required: ["data"],
        additionalProperties: false,
      };
      tool.implementation.source =
        'export default function run(){return {data:"x".repeat(523900)};}';
      tool.implementation.modules = {};
      const created = await f.services.catalog.create(owner, {
        slug: "edge",
        displayName: "Presentation edge",
        source,
      });
      await publish(f, created.integrationId, created.draftRevisionId);
      const advertised = (await f.services.execution.discover(f.grant)).find(
        (item) => item.name === "edge.echo",
      );
      expect(advertised?.inputSchema).toMatchObject({
        type: "object",
        $ref: "#/$defs/arguments",
        $defs: { arguments: { type: "object" } },
      });
      const queued = await f.services.execution.invoke(f.grant, {
        name: "edge.echo",
        arguments: {},
        metadata: { idempotency_key: "full-mcp-bound" },
      });
      await f.services.execution.drain();
      const failed = await f.services.execution.getRun(f.grant, queued.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: { code: "payload_too_large" },
      });
      expect(failed).not.toHaveProperty("businessResult");
      expect(
        new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "\0".repeat(128),
            result: toolResult(failed),
          }),
        ).length,
      ).toBeLessThanOrEqual(1048576);
    }));

  it("previews only explicit validated drafts as scope-only, never callable, without intent or authority mutation", () =>
    withAuthoring(async (f) => {
      const source = authored("scopes");
      if (source.kind !== "typescript")
        throw new Error("Unexpected authored test source");
      source.tools[0]!.requirements = {
        identity: {
          provider: "github",
          methods: ["bearer"],
          scopes: ["user:email"],
        },
      };
      const created = await f.services.catalog.create(owner, {
        slug: "scopes",
        displayName: "Scope-only review",
        source,
      });
      const transport = createLocalHttpTransport(),
        provider = createGithubProvider({ transport });
      const input = {
        accountId: null,
        provider: "github",
        currentScopes: [],
        requestedScopes: ["user"],
        coversScopes: provider.coversScopes,
        review: { ...created, profileIds: [f.profileId] },
      };
      await expect(
        f.services.catalog.previewOAuthImpact(owner, input),
      ).rejects.toMatchObject({ code: "publication_conflict" });
      await f.services.catalog.validate(
        owner,
        created.integrationId,
        created.draftRevisionId,
      );
      const before = await f.binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(ORG)
        .first("epoch");
      expect(await f.services.catalog.previewOAuthImpact(owner, input)).toEqual(
        {
          published: [],
          proposed: {
            integrationId: created.integrationId,
            draftRevisionId: created.draftRevisionId,
            callable: false,
            profiles: [
              {
                profileId: f.profileId,
                label: "Selected profile",
                tools: [
                  {
                    name: "scopes.echo",
                    requirement: "identity",
                    currentScopesSatisfied: false,
                    requestedScopesSufficient: true,
                  },
                ],
              },
            ],
          },
        },
      );
      await expect(
        f.services.catalog.previewOAuthImpact(owner, {
          ...input,
          review: { ...created, profileIds: [crypto.randomUUID()] },
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        await f.binding
          .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
          .bind(ORG)
          .first("epoch"),
      ).toBe(before);
      expect(
        await f.binding
          .prepare("SELECT count(*) AS count FROM control_oauth_states")
          .first("count"),
      ).toBe(0);
      expect(
        (await f.services.execution.discover(f.grant)).some(
          (tool) => tool.name === "scopes.echo",
        ),
      ).toBe(false);
    }));

  it(
    "rejects the complete compact shared-schema expansion before any active revision or Profile authority changes",
    () =>
      withAuthoring(async (f) => {
        const paths = Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [
            `/items/${index}`,
            {
              get: {
                operationId: `item${index}`,
                parameters: [
                  {
                    name: "query",
                    in: "query",
                    schema: { $ref: "#/components/schemas/shared" },
                  },
                ],
                responses: {
                  "200": {
                    description: "Success",
                    content: {
                      "application/json": { schema: { type: "object" } },
                    },
                  },
                },
              },
            },
          ]),
        );
        const document = JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Compact shared schema", version: "1" },
          servers: [{ url: "https://example.com" }],
          components: {
            schemas: {
              shared: {
                type: "object",
                description: "x".repeat(32768),
                properties: { value: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
          paths,
        });
        expect(new TextEncoder().encode(document).length).toBeLessThan(
          5 * 1048576,
        );
        const source: Source = {
          kind: "openapi",
          document,
          approvedRefOrigins: [],
          nameMapping: {},
          securityMappings: {},
          operationOptions: {},
        };
        const before = await f.services.catalog.profile(ORG, f.profileId),
          created = await f.services.catalog.create(owner, {
            slug: "expansion",
            displayName: "Whole-revision budget rejection",
            source,
          });
        await expect(
          f.services.catalog.validate(
            owner,
            created.integrationId,
            created.draftRevisionId,
          ),
        ).rejects.toMatchObject({
          code: "import_invalid",
          status: 413,
          message: expect.stringMatching(/derived.*budget/i),
        });
        expect(
          (await f.services.catalog.get(ORG, created.integrationId))
            .currentRevisionId,
        ).toBeNull();
        expect(await f.services.catalog.profile(ORG, f.profileId)).toEqual(
          before,
        );
        expect(
          await f.binding
            .prepare(
              "SELECT count(*) AS count FROM control_revision_manifests WHERE revision_id=?",
            )
            .bind(created.draftRevisionId)
            .first("count"),
        ).toBe(0);
        expect(
          await f.binding
            .prepare(
              "SELECT count(*) AS count FROM control_reviews WHERE revision_id=?",
            )
            .bind(created.draftRevisionId)
            .first("count"),
        ).toBe(0);
        expect(await f.services.execution.fixtureStats(ORG)).toEqual({
          writes: 0,
          total: 0,
        });
      }),
    30000,
  );

  it(
    "round-trips a real 5MiB OpenAPI root and 500 selected tools through chunked storage and scoped expiring pagination",
    () =>
      withAuthoring(async (f) => {
        const paths = Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [
            `/items/${index}`,
            {
              get: {
                operationId: `item${index}`,
                parameters: [
                  {
                    name: "query",
                    in: "query",
                    schema: { type: "string", description: "x".repeat(7000) },
                  },
                ],
                responses: {
                  "200": {
                    description: "Success",
                    content: {
                      "application/json": { schema: { type: "object" } },
                    },
                  },
                },
              },
            },
          ]),
        );
        const root = JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Real bounded catalogue", version: "1" },
          servers: [{ url: "https://example.com" }],
          paths,
        });
        const bytes = new TextEncoder().encode(root).length;
        expect(bytes).toBeLessThan(5 * 1048576);
        const source: Source = {
          kind: "openapi",
          document: root + " ".repeat(5 * 1048576 - bytes),
          approvedRefOrigins: [],
          nameMapping: {},
          securityMappings: {},
          operationOptions: {},
        };
        const created = await f.services.catalog.create(owner, {
          slug: "bulk",
          displayName: "Complete bounded catalogue",
          source,
        });
        const report = await f.services.catalog.validate(
          owner,
          created.integrationId,
          created.draftRevisionId,
        );
        expect(report.accepted).toHaveLength(500);
        expect(report.rejected).toEqual([]);
        expect(
          new TextEncoder().encode(JSON.stringify(report)).length,
        ).toBeGreaterThan(2000000);
        const current = await f.services.catalog.profile(ORG, f.profileId);
        await f.services.catalog.publish(owner, created.integrationId, {
          draftRevisionId: created.draftRevisionId,
          reportDigest: report.reportDigest,
          expectedCurrentRevisionId: null,
          profiles: [
            {
              profileId: f.profileId,
              expectedRevision: current.revision,
              tools: report.accepted.map((tool) => tool.name),
              bindings: {},
              policies: [],
            },
          ],
        });
        expect(
          (await f.services.catalog.profile(ORG, f.profileId)).tools,
        ).toHaveLength(501);
        expect(
          await f.binding
            .prepare(
              "SELECT max(length(CAST(content AS BLOB))) AS bytes FROM control_catalog_chunks",
            )
            .first<number>("bytes"),
        ).toBeLessThanOrEqual(262144);
        expect(
          (await f.services.catalog.snapshot(ORG, created.draftRevisionId))
            .accepted,
        ).toHaveLength(500);
        let page = await f.services.execution.discoveryPage(f.grant),
          cursor = page.nextCursor;
        expect(page.tools).toHaveLength(50);
        expect(cursor).toMatch(/^1\.[A-Za-z0-9_-]{71}$/);
        if (!cursor) throw new Error("Expected a bounded pagination cursor");
        const all = [...page.tools];
        while (page.nextCursor) {
          page = await f.services.execution.discoveryPage(
            f.grant,
            page.nextCursor,
          );
          expect(page.tools.length).toBeLessThanOrEqual(50);
          expect(
            new TextEncoder().encode(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "\0".repeat(128),
                result: page,
              }),
            ).length,
          ).toBeLessThanOrEqual(1048576);
          all.push(...page.tools);
        }
        expect(all).toHaveLength(502);
        expect(new Set(all.map((tool) => tool.name)).size).toBe(502);
        const altered =
          cursor.slice(0, -2) +
          (cursor.at(-2) === "A" ? "B" : "A") +
          cursor.at(-1);
        await expect(
          f.services.execution.discoveryPage(f.grant, altered),
        ).rejects.toMatchObject({ code: "invalid_request" });
        const otherToken = await f.services.execution.issueGrant(
            ORG,
            f.profileId,
            "Wrong cursor scope",
            undefined,
            USER,
          ),
          other = await f.services.execution.authenticate(
            f.profileId,
            otherToken.token,
          );
        const fresh = await f.services.execution.discoveryPage(f.grant);
        if (!fresh.nextCursor) throw new Error("Expected fresh cursor");
        await expect(
          f.services.execution.discoveryPage(other, fresh.nextCursor),
        ).rejects.toMatchObject({ code: "invalid_request" });
        f.clock.value += 600001;
        await expect(
          f.services.execution.discoveryPage(f.grant, fresh.nextCursor),
        ).rejects.toMatchObject({ code: "invalid_request" });
        const beforeMutation = await f.services.execution.discoveryPage(
          f.grant,
        );
        if (!beforeMutation.nextCursor)
          throw new Error("Expected epoch cursor");
        await f.services.execution.setPolicies(ORG, f.profileId, [
          { pattern: "fixture.counter.increment", decision: "allow" },
        ]);
        await expect(
          f.services.execution.discoveryPage(
            f.grant,
            beforeMutation.nextCursor,
          ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(await f.services.execution.fixtureStats(ORG)).toEqual({
          writes: 0,
          total: 0,
        });
      }),
    30000,
  );
});
