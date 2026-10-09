import { readFile } from "node:fs/promises";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import type {
  ArtifactRef,
  SelectedAccount,
} from "@scaffold/schema/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/execution/canonical";
import { ControlError } from "../src/execution/service";
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_RETENTION_MS,
  ARTIFACT_STAGING_MS,
  type ArtifactAuthority,
  type ArtifactFile,
  type ArtifactFrozenInput,
  type ArtifactPrincipal,
  type ArtifactRunContext,
  type ArtifactScope,
  type ArtifactService,
  binaryCapacityAvailable,
  createArtifactsService,
  normalizeArtifactMediaType,
  sanitizeArtifactFilename,
} from "../src/integrations/artifacts";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROFILE = "00000000-0000-4000-8000-000000000002";
const GRANT = "00000000-0000-4000-8000-000000000003";
const RUN = "00000000-0000-4000-8000-000000000004";
const OTHER_GRANT = "00000000-0000-4000-8000-000000000005";
const OTHER_RUN = "00000000-0000-4000-8000-000000000006";
const ACCOUNT = "00000000-0000-4000-8000-000000000007";
const OTHER_ORG = "00000000-0000-4000-8000-000000000008";
const USER = "00000000-0000-4000-8000-000000000009";
const owner: ArtifactPrincipal & { kind: "owner" } = {
  kind: "owner",
  orgId: ORG,
  userId: USER,
};
const caller: ArtifactPrincipal = {
  kind: "grant",
  orgId: ORG,
  grantId: GRANT,
  profileId: PROFILE,
  principalId: USER,
};
const secret = "public-unit-artifact-purpose-secret-not-production";
let db: SQLiteBinding;
let service: ArtifactService;
let clock: number;
let context: ArtifactRunContext;
let authority: ArtifactAuthority;
let accountDisabled: boolean;
let identityChanged: boolean;
let targetDenied: boolean;
let checkedSources: ArtifactScope[];

function generated(
  size: number,
  seed = 17,
  piece = 65521,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (offset === size) {
          controller.close();
          return;
        }
        const bytes = new Uint8Array(Math.min(piece, size - offset));
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = (offset + i + seed) % 251;
        offset += bytes.length;
        controller.enqueue(bytes);
      },
    },
    { highWaterMark: 0 },
  );
}
function upload(
  size = 3,
  extra: Partial<Parameters<ArtifactService["upload"]>[1]> = {},
): Promise<ArtifactRef> {
  return service.upload(owner, {
    profileId: PROFILE,
    grantId: GRANT,
    body: generated(size),
    mediaType: "application/octet-stream",
    ...extra,
  });
}
async function consume(artifact: ArtifactRef): Promise<Uint8Array> {
  const response = await service.download(caller, artifact.artifact_id);
  if (artifact.size_bytes === 0) expect(binaryCapacityAvailable()).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}
async function seedRun(
  runId: string,
  grantId: string,
  deadline: number | null,
  executionDeadline = deadline ?? clock + 300000,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO control_runs (id,org_id,grant_id,profile_id,tool,tool_revision,status,created_at,updated_at,deadline,policy_decision,display_json,admitted_epoch,lease_owner,lease_until) VALUES (?,?,?,?,'example.binary.get','tool-public-v1','running',?,?,?,'allow','{}',0,'claim-public',?)",
    )
    .bind(
      runId,
      ORG,
      grantId,
      PROFILE,
      clock,
      clock,
      deadline,
      executionDeadline,
    )
    .run();
}
async function freezeFiles(
  run: ArtifactRunContext,
  files: ArtifactRef[],
  targetRequirement: string | null = "target",
): Promise<void> {
  const values: ArtifactFrozenInput[] = [];
  for (const file of files)
    values.push({
      artifact_id: file.artifact_id,
      metadataDigest: await service.metadataDigest(
        run,
        { artifact_id: file.artifact_id },
        targetRequirement,
      ),
      targetRequirement,
    });
  await service.freezeInputs(run, values);
}
async function newRunContext(): Promise<ArtifactRunContext> {
  const next = { ...context, runId: crypto.randomUUID() };
  await seedRun(
    next.runId,
    next.grantId,
    next.deadline,
    next.executionDeadline,
  );
  return next;
}
async function checkScope(scope: ArtifactScope): Promise<void> {
  const row = await db
    .prepare(
      "SELECT g.revoked_at,g.expires_at,p.enabled FROM control_grants g JOIN control_profiles p ON p.id=g.profile_id WHERE g.id=? AND g.org_id=? AND g.profile_id=?",
    )
    .bind(scope.grantId, scope.orgId, scope.profileId)
    .first<{
      revoked_at: number | null;
      expires_at: number | null;
      enabled: number;
    }>();
  if (!row) throw new ControlError("not_found", "Not found", 404);
  if (
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= clock) ||
    !row.enabled
  )
    throw new ControlError("forbidden", "Current access is disabled", 403);
  if (scope.runId !== null) {
    checkedSources.push(scope);
    if (accountDisabled)
      throw new ControlError("forbidden", "Source Account disabled", 403);
    if (identityChanged)
      throw new ControlError(
        "account_identity_changed",
        "Source identity changed",
        409,
      );
  }
}
beforeEach(async () => {
  clock = Date.UTC(2026, 9, 8);
  db = new SQLiteBinding(":memory:");
  for (const name of [
    "0000_initial.sql",
    "0001_control.sql",
    "0004_m2_artifacts.sql",
  ])
    await db.exec(
      await readFile(
        new URL(`../../database/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await db
    .prepare(
      "INSERT INTO organizations (id,name,slug) VALUES (?,'Artifact Public Unit','artifact-public-unit')",
    )
    .bind(ORG)
    .run();
  await db
    .prepare(
      "INSERT INTO control_profiles (id,org_id,label,created_at,updated_at) VALUES (?,?,'artifact-public',?,?)",
    )
    .bind(PROFILE, ORG, clock, clock)
    .run();
  for (const grantId of [GRANT, OTHER_GRANT])
    await db
      .prepare(
        "INSERT INTO control_grants (id,org_id,profile_id,label,token_hash,created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(grantId, ORG, PROFILE, grantId, grantId, clock)
      .run();
  const selected: SelectedAccount = {
    accountId: ACCOUNT,
    identityDigest: "a".repeat(64),
    alias: "Public disposable unit Account",
    requirement: "target",
  };
  context = {
    orgId: ORG,
    profileId: PROFILE,
    grantId: GRANT,
    runId: RUN,
    claimId: "claim-public",
    deadline: clock + 300000,
    executionDeadline: clock + 300000,
    selectedAccounts: { target: selected },
  };
  await seedRun(RUN, GRANT, context.deadline);
  await seedRun(OTHER_RUN, OTHER_GRANT, context.deadline);
  accountDisabled = false;
  identityChanged = false;
  targetDenied = false;
  checkedSources = [];
  authority = {
    checkAccess: vi.fn(async (principal, source) => {
      if (principal.orgId !== source.orgId)
        throw new ControlError("not_found", "Not found", 404);
      await checkScope(source);
    }),
    checkRun: vi.fn(async (run, source) => {
      const row = await db
        .prepare(
          "SELECT org_id,grant_id,profile_id,status,lease_owner,deadline,lease_until FROM control_runs WHERE id=?",
        )
        .bind(run.runId)
        .first<{
          org_id: string;
          grant_id: string;
          profile_id: string;
          status: string;
          lease_owner: string;
          deadline: number | null;
          lease_until: number;
        }>();
      if (
        !row ||
        row.org_id !== run.orgId ||
        row.grant_id !== run.grantId ||
        row.profile_id !== run.profileId ||
        row.status !== "running" ||
        row.lease_owner !== run.claimId ||
        row.deadline !== run.deadline ||
        run.executionDeadline > row.lease_until
      )
        throw new ControlError(
          "forbidden",
          "Current Run authority invalid",
          403,
        );
      await checkScope({
        artifactId: "",
        orgId: run.orgId,
        grantId: run.grantId,
        profileId: run.profileId,
        ownerUserId: null,
        runId: null,
        selectedAccounts: {},
      });
      if (source) await checkScope(source);
      if (targetDenied)
        throw new ControlError(
          "broker_forbidden",
          "Destination permission denied",
          403,
        );
    }),
  };
  service = createArtifactsService({
    database: { $client: db },
    secret,
    authority,
    now: () => clock,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

describe("M2 protected artifact SQLite persistence", () => {
  it.each([
    0,
    1,
    3,
    55,
    56,
    63,
    64,
    65,
    127,
    128,
    129,
    ARTIFACT_CHUNK_BYTES,
    ARTIFACT_CHUNK_BYTES + 1,
  ])(
    "authenticates exact finite plaintext and SHA-256 at %i bytes",
    async (size) => {
      const artifact = await upload(size);
      const bytes = await consume(artifact);
      expect(bytes.length).toBe(size);
      const expected = new Uint8Array(size);
      for (let i = 0; i < size; i++) expected[i] = (i + 17) % 251;
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", expected),
      );
      expect(artifact.sha256).toBe(
        Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        ),
      );
      expect(bytes).toEqual(expected);
      const rows = await db
        .prepare(
          "SELECT plaintext_bytes,length(ciphertext) AS encrypted FROM control_artifact_chunks WHERE artifact_id=?",
        )
        .bind(artifact.artifact_id)
        .all<{ plaintext_bytes: number; encrypted: number }>();
      expect(rows.results.length).toBe(Math.ceil(size / ARTIFACT_CHUNK_BYTES));
      for (const row of rows.results) {
        expect(row.plaintext_bytes).toBeLessThanOrEqual(ARTIFACT_CHUNK_BYTES);
        expect(row.encrypted).toBe(row.plaintext_bytes + 28);
      }
    },
  );
  it("round trips 25 MiB in 50 encrypted rows and rejects 25 MiB+1 without ready content", async () => {
    const prepare = db.prepare.bind(db);
    const statements: string[] = [];
    let maxBindings = 0,
      maxBlobBytes = 0;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...args: unknown[]) => {
              maxBindings = Math.max(maxBindings, args.length);
              const blobBytes = args.reduce<number>(
                (total, value) =>
                  total +
                  (value instanceof ArrayBuffer || ArrayBuffer.isView(value)
                    ? value.byteLength
                    : 0),
                0,
              );
              maxBlobBytes = Math.max(maxBlobBytes, blobBytes);
              return wrap(target.bind(...args));
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      statements.push(sql);
      return wrap(prepare(sql));
    });
    const artifact = await upload(ARTIFACT_MAX_BYTES, {
      contentLength: String(ARTIFACT_MAX_BYTES),
    });
    expect(statements.length).toBeLessThanOrEqual(50);
    expect(maxBindings).toBeLessThanOrEqual(100);
    expect(maxBlobBytes).toBeLessThanOrEqual(4 * (ARTIFACT_CHUNK_BYTES + 28));
    expect(
      statements.filter((sql) =>
        sql.startsWith("UPDATE control_artifact_chunks"),
      ),
    ).toHaveLength(0);
    spy.mockRestore();
    const bytes = await consume(artifact);
    expect(bytes.length).toBe(ARTIFACT_MAX_BYTES);
    for (const index of [
      0,
      ARTIFACT_CHUNK_BYTES - 1,
      ARTIFACT_CHUNK_BYTES,
      ARTIFACT_MAX_BYTES - 1,
    ])
      expect(bytes[index]).toBe((index + 17) % 251);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM control_artifact_chunks WHERE artifact_id=?",
        )
        .bind(artifact.artifact_id)
        .first("count"),
    ).toBe(50);
    await expect(upload(ARTIFACT_MAX_BYTES + 1)).rejects.toMatchObject({
      code: "payload_too_large",
      status: 413,
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM control_artifacts WHERE state='ready'",
        )
        .first("count"),
    ).toBe(1);
  }, 60000);
  it("uses fresh nonces and an artifact-purpose key rather than M1 payload ciphertext", async () => {
    const first = await upload(3),
      second = await upload(3);
    const a = await db
      .prepare(
        "SELECT ciphertext FROM control_artifact_chunks WHERE artifact_id=?",
      )
      .bind(first.artifact_id)
      .first<{ ciphertext: Uint8Array }>();
    const b = await db
      .prepare(
        "SELECT ciphertext FROM control_artifact_chunks WHERE artifact_id=?",
      )
      .bind(second.artifact_id)
      .first<{ ciphertext: Uint8Array }>();
    expect(a!.ciphertext).not.toEqual(b!.ciphertext);
    const wrongKeyService = createArtifactsService({
      database: { $client: db },
      secret: "other-public-unit-secret",
      authority,
      now: () => clock,
    });
    await expect(
      wrongKeyService.download(caller, first.artifact_id),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
  it("normalizes broad MIME, safe filenames, attachment/no-sniff/private cache, and bodyless HEAD", async () => {
    const artifact = await upload(3, {
      mediaType: "Application/X-Custom+Binary; charset=utf-8",
      filename: '../source.ts\\\r\n";😃',
    });
    expect(artifact.media_type).toBe("application/x-custom+binary");
    expect(artifact.filename).not.toContain("/");
    expect(artifact.filename).not.toContain("\\");
    for (let index = 0; index < artifact.filename.length; index++) {
      expect(artifact.filename.charCodeAt(index)).toBeGreaterThan(31);
    }
    expect(artifact).not.toHaveProperty("url");
    const head = await service.download(owner, artifact.artifact_id, {
      method: "HEAD",
    });
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("3");
    expect(head.headers.get("content-disposition")).toMatch(
      /^attachment; filename=/,
    );
    expect(head.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''",
    );
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    expect(head.headers.has("access-control-allow-origin")).toBe(false);
    expect(
      (
        await service.download(caller, artifact.artifact_id, {
          range: "bytes=0-1",
        })
      ).status,
    ).toBe(416);
    expect(sanitizeArtifactFilename("\x80.\x9f")).toBe("artifact.bin");
    expect(sanitizeArtifactFilename("😀".repeat(129))).toBe("😀".repeat(128));
    expect(() =>
      normalizeArtifactMediaType("application/octet-stream\r\nX-Fake: y"),
    ).toThrow();
    await expect(upload(3, { contentEncoding: "gzip" })).rejects.toMatchObject({
      status: 415,
    });
  });
  it("requires exact active Grant/Profile and hides foreign/absent resources identically", async () => {
    const artifact = await upload();
    for (const principal of [
      { ...caller, orgId: OTHER_ORG },
      { ...caller, grantId: OTHER_GRANT },
      { ...caller, profileId: crypto.randomUUID() },
    ] as ArtifactPrincipal[]) {
      await expect(
        service.download(principal, artifact.artifact_id),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
    await expect(
      service.download(caller, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(service.download(caller, "not-a-uuid")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    await db
      .prepare("UPDATE control_grants SET revoked_at=? WHERE id=?")
      .bind(clock, GRANT)
      .run();
    await expect(
      service.download(caller, artifact.artifact_id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.download(owner, artifact.artifact_id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(upload()).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks access before every emitted bounded download chunk", async () => {
    const artifact = await upload(ARTIFACT_CHUNK_BYTES + 1);
    const response = await service.download(caller, artifact.artifact_id);
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBe(ARTIFACT_CHUNK_BYTES);
    await db
      .prepare("UPDATE control_grants SET revoked_at=? WHERE id=?")
      .bind(clock, GRANT)
      .run();
    await expect(reader.read()).rejects.toMatchObject({ status: 403 });
    reader.releaseLock();
  });
  it("keeps interrupted staging inaccessible and deletes chunks with bounded shared-drain cleanup", async () => {
    let calls = 0;
    const broken = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (calls++ === 0)
            controller.enqueue(new Uint8Array(4 * ARTIFACT_CHUNK_BYTES));
          else controller.error(new Error("public-fixture interruption"));
        },
      },
      { highWaterMark: 0 },
    );
    await expect(upload(0, { body: broken })).rejects.toMatchObject({
      code: "internal_error",
    });
    const staging = await db
      .prepare("SELECT id,state,staging_expires_at FROM control_artifacts")
      .first<{ id: string; state: string; staging_expires_at: number }>();
    expect(staging!.state).toBe("staging");
    expect(staging!.staging_expires_at).toBe(clock + ARTIFACT_STAGING_MS);
    await expect(service.download(owner, staging!.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      (await service.cleanup({ maxArtifacts: 1, maxChunks: 1 })).chunks,
    ).toBe(0);
    clock += ARTIFACT_STAGING_MS;
    for (let remaining = 3; remaining > 0; remaining--)
      expect(
        await service.cleanup({ maxArtifacts: 1, maxChunks: 1 }),
      ).toMatchObject({ artifacts: 0, chunks: 1 });
    expect(
      await service.cleanup({ maxArtifacts: 1, maxChunks: 1 }),
    ).toMatchObject({ artifacts: 1, chunks: 1 });
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM control_artifacts")
        .first("count"),
    ).toBe(0);
  });
  it("fails closed on write quota errors without exposing SQL or publishing a partial manifest", async () => {
    const prepare = db.prepare.bind(db);
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...args: unknown[]) => wrap(target.bind(...args));
          if (property === "run")
            return async () => {
              throw new Error("private database quota SQL detail");
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    vi.spyOn(db, "prepare").mockImplementation((sql) =>
      sql.includes("INSERT INTO control_artifact_chunks")
        ? wrap(prepare(sql))
        : prepare(sql),
    );
    await expect(upload(ARTIFACT_CHUNK_BYTES)).rejects.toMatchObject({
      code: "internal_error",
      message: "The artifact could not be stored safely.",
    });
    expect(
      await prepare(
        "SELECT count(*) AS count FROM control_artifacts WHERE state='ready'",
      ).first("count"),
    ).toBe(0);
    clock += ARTIFACT_STAGING_MS;
    expect((await service.cleanup()).artifacts).toBe(1);
  });
  it.each([
    "missing",
    "ciphertext",
    "truncated",
    "length",
    "metadata",
    "digest",
    "extra",
    "reordered",
  ])(
    "rejects %s corruption before returning any successful body",
    async (damage) => {
      const artifact = await upload(ARTIFACT_CHUNK_BYTES + 9);
      if (damage === "missing")
        await db
          .prepare(
            "DELETE FROM control_artifact_chunks WHERE artifact_id=? AND chunk_index=0",
          )
          .bind(artifact.artifact_id)
          .run();
      if (damage === "truncated") {
        await db.exec("PRAGMA ignore_check_constraints = ON");
        await db
          .prepare(
            "UPDATE control_artifact_chunks SET ciphertext=substr(ciphertext,1,length(ciphertext)-1) WHERE artifact_id=? AND chunk_index=0",
          )
          .bind(artifact.artifact_id)
          .run();
      }
      if (damage === "ciphertext") {
        const chunk = await db
          .prepare(
            "SELECT ciphertext FROM control_artifact_chunks WHERE artifact_id=? AND chunk_index=0",
          )
          .bind(artifact.artifact_id)
          .first<{ ciphertext: Uint8Array }>();
        const value = new Uint8Array(chunk!.ciphertext);
        value[20] = value[20]! ^ 1;
        await db
          .prepare(
            "UPDATE control_artifact_chunks SET ciphertext=? WHERE artifact_id=? AND chunk_index=0",
          )
          .bind(value, artifact.artifact_id)
          .run();
      }
      if (damage === "length")
        await db
          .prepare(
            "UPDATE control_artifact_chunks SET declared_size=declared_size-1 WHERE artifact_id=?",
          )
          .bind(artifact.artifact_id)
          .run();
      if (damage === "metadata")
        await db
          .prepare(
            "UPDATE control_artifacts SET expires_at=expires_at+1 WHERE id=?",
          )
          .bind(artifact.artifact_id)
          .run();
      if (damage === "digest")
        await db
          .prepare("UPDATE control_artifacts SET sha256=? WHERE id=?")
          .bind("0".repeat(64), artifact.artifact_id)
          .run();
      if (damage === "extra")
        await db
          .prepare(
            "INSERT INTO control_artifact_chunks SELECT artifact_id,2,plaintext_bytes,declared_size,ciphertext FROM control_artifact_chunks WHERE artifact_id=? AND chunk_index=1",
          )
          .bind(artifact.artifact_id)
          .run();
      if (damage === "reordered") {
        const chunks = await db
          .prepare(
            "SELECT chunk_index,plaintext_bytes,ciphertext FROM control_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index",
          )
          .bind(artifact.artifact_id)
          .all<{
            chunk_index: number;
            plaintext_bytes: number;
            ciphertext: Uint8Array;
          }>();
        for (let i = 0; i < 2; i++)
          await db
            .prepare(
              "UPDATE control_artifact_chunks SET plaintext_bytes=?,ciphertext=? WHERE artifact_id=? AND chunk_index=?",
            )
            .bind(
              chunks.results[1 - i]!.plaintext_bytes,
              chunks.results[1 - i]!.ciphertext,
              artifact.artifact_id,
              i,
            )
            .run();
      }
      await expect(
        service.download(caller, artifact.artifact_id),
      ).rejects.toMatchObject({ code: "internal_error", status: 500 });
      await expect(
        service.download(caller, artifact.artifact_id, { method: "HEAD" }),
      ).rejects.toMatchObject({ code: "internal_error" });
    },
  );
  it("verifies the final plaintext digest even when replacement chunk ciphertext authenticates", async () => {
    const artifact = await upload(3);
    const encoder = new TextEncoder();
    const rawKey = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`mcpone/artifact/content/v1:${secret}`),
    );
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
      "encrypt",
    ]);
    const nonce = new Uint8Array(12).fill(7);
    const aad = encoder.encode(
      canonicalJson(["mcpone-artifact-v1", ORG, artifact.artifact_id, 0, 3, 3]),
    );
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad },
        key,
        new Uint8Array([9, 8, 7]),
      ),
    );
    const packed = new Uint8Array(12 + encrypted.length);
    packed.set(nonce);
    packed.set(encrypted, 12);
    await db
      .prepare(
        "UPDATE control_artifact_chunks SET ciphertext=? WHERE artifact_id=? AND chunk_index=0",
      )
      .bind(packed, artifact.artifact_id)
      .run();
    await expect(
      service.download(caller, artifact.artifact_id),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
  it("binds equal-length ciphertext to artifact/organization/index/declared total with authenticated AAD", async () => {
    const first = await upload(ARTIFACT_CHUNK_BYTES * 2),
      second = await upload(ARTIFACT_CHUNK_BYTES * 2);
    const firstChunk = await db
      .prepare(
        "SELECT ciphertext FROM control_artifact_chunks WHERE artifact_id=? AND chunk_index=0",
      )
      .bind(first.artifact_id)
      .first<{ ciphertext: Uint8Array }>();
    await db
      .prepare(
        "UPDATE control_artifact_chunks SET ciphertext=? WHERE artifact_id=? AND chunk_index=1",
      )
      .bind(firstChunk!.ciphertext, first.artifact_id)
      .run();
    await expect(
      service.download(caller, first.artifact_id),
    ).rejects.toMatchObject({ code: "internal_error" });
    await db
      .prepare(
        "UPDATE control_artifact_chunks SET ciphertext=? WHERE artifact_id=? AND chunk_index=0",
      )
      .bind(firstChunk!.ciphertext, second.artifact_id)
      .run();
    await expect(
      service.download(caller, second.artifact_id),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
  it("expires synchronously while retaining authenticated audit metadata after bounded physical deletion", async () => {
    const artifact = await upload(ARTIFACT_CHUNK_BYTES + 1);
    clock += ARTIFACT_RETENTION_MS;
    await expect(
      service.download(caller, artifact.artifact_id),
    ).rejects.toMatchObject({ code: "content_expired", status: 410 });
    expect(await service.auditMetadata(owner, artifact.artifact_id)).toEqual({
      artifact,
      contentExpired: true,
    });
    expect(
      await service.cleanup({ maxArtifacts: 1, maxChunks: 1 }),
    ).toMatchObject({ chunks: 1, artifacts: 0 });
    expect(
      await service.cleanup({ maxArtifacts: 1, maxChunks: 1 }),
    ).toMatchObject({ chunks: 1, artifacts: 1 });
    expect(await service.auditMetadata(owner, artifact.artifact_id)).toEqual({
      artifact,
      contentExpired: true,
    });
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM control_artifacts WHERE id=?")
        .bind(artifact.artifact_id)
        .first("count"),
    ).toBe(1);
  });
  it("defers unauthenticated expired metadata without blocking other cleanup or deleting its ciphertext", async () => {
    const corruptArtifact = await upload();
    clock++;
    const intactArtifact = await upload();
    await db
      .prepare("UPDATE control_artifacts SET metadata_cipher='AA==' WHERE id=?")
      .bind(corruptArtifact.artifact_id)
      .run();
    clock += ARTIFACT_RETENTION_MS;
    expect(
      await service.cleanup({ maxArtifacts: 1, maxChunks: 1 }),
    ).toMatchObject({ artifacts: 0, chunks: 0 });
    expect(
      await service.cleanup({ maxArtifacts: 1, maxChunks: 1 }),
    ).toMatchObject({ artifacts: 1, chunks: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM control_artifact_chunks WHERE artifact_id=?",
        )
        .bind(corruptArtifact.artifact_id)
        .first("count"),
    ).toBe(1);
    expect(
      await service.auditMetadata(owner, intactArtifact.artifact_id),
    ).toEqual({ artifact: intactArtifact, contentExpired: true });
    await expect(
      service.auditMetadata(owner, corruptArtifact.artifact_id),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
  it("freezes producing Run Accounts and enforces source and target authority on every read/reuse", async () => {
    const artifact = await service.createFromResponse(
      context,
      new Response(generated(9)),
      { mediaType: "application/zip", filename: "source.ts" },
    );
    await freezeFiles(context, [artifact]);
    const file = await service.readForRun(
      context,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    expect(file.ref).toEqual(artifact);
    expect(file.bytes.length).toBe(9);
    file.release();
    expect(file.bytes.every((byte) => byte === 0)).toBe(true);
    expect(
      checkedSources.some(
        (source) =>
          source.runId === RUN &&
          source.selectedAccounts.target!.accountId === ACCOUNT,
      ),
    ).toBe(true);
    accountDisabled = true;
    await expect(
      service.download(owner, artifact.artifact_id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ status: 403 });
    accountDisabled = false;
    identityChanged = true;
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ code: "account_identity_changed" });
    identityChanged = false;
    targetDenied = true;
    await expect(
      service.withMultipartFiles(
        context,
        [{ artifact_id: artifact.artifact_id }],
        "target",
        async () => "unreachable",
      ),
    ).rejects.toMatchObject({ code: "broker_forbidden" });
    targetDenied = false;
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id },
        "missing",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.readForRun(
        { ...context, runId: OTHER_RUN, grantId: OTHER_GRANT },
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id, size_bytes: 1 } as {
          artifact_id: string;
        },
        "target",
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });
  it("owner-uploaded bytes grant no source Account authority and metadataDigest checks current authority", async () => {
    const artifact = await upload();
    expect(
      await service.metadataDigest(
        context,
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
    const call = vi
      .mocked(authority.checkRun)
      .mock.calls.find(
        ([, source]) => source?.artifactId === artifact.artifact_id,
      );
    expect(call![1]!.selectedAccounts).toEqual({});
    expect(call![1]!.runId).toBeNull();
    await expect(
      service.readForRun(
        { ...context, claimId: "foreign-claim" },
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("freezes empty input sets explicitly and fails closed if a frozen set is missing", async () => {
    const artifact = await upload();
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ code: "internal_error" });
    await expect(service.verifyInputs(context)).rejects.toMatchObject({
      code: "internal_error",
    });
    await service.freezeInputs(context, []);
    await expect(service.verifyInputs(context)).resolves.toBeUndefined();
    expect(
      await service.withMultipartFiles(
        context,
        [],
        null,
        async (files) => files.length,
      ),
    ).toBe(0);
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments", status: 409 });
    await db
      .prepare("DELETE FROM control_artifact_run_inputs WHERE run_id=?")
      .bind(RUN)
      .run();
    await expect(service.verifyInputs(context)).rejects.toMatchObject({
      code: "internal_error",
    });
  });
  it("freezes empty Allow inputs with a null approval deadline but enforces the separate execution ceiling", async () => {
    context = { ...context, runId: crypto.randomUUID(), deadline: null };
    await seedRun(
      context.runId,
      context.grantId,
      null,
      context.executionDeadline,
    );
    await service.freezeInputs(context, []);
    await expect(service.verifyInputs(context)).resolves.toBeUndefined();
    const artifact = await service.createFromResponse(
      context,
      new Response(generated(3)),
      { mediaType: "application/octet-stream" },
    );
    expect(artifact.size_bytes).toBe(3);
    clock = context.executionDeadline;
    await expect(
      service.createFromResponse(context, new Response(generated(3)), {
        mediaType: "application/octet-stream",
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(binaryCapacityAvailable()).toBe(true);
  });
  it("freezes metadata under explicit pending admission and verifies it under the later running claim", async () => {
    const artifact = await upload();
    await db
      .prepare(
        "UPDATE control_runs SET status='pending_approval',lease_owner=NULL WHERE id=?",
      )
      .bind(RUN)
      .run();
    const admissionContext = { ...context, claimId: "admission" };
    const runningAuthority = authority.checkRun;
    authority.checkRun = async (run, source, requirement) => {
      if (run.claimId !== "admission")
        return runningAuthority(run, source, requirement);
      const pending = await db
        .prepare(
          "SELECT status,org_id,grant_id,profile_id,deadline FROM control_runs WHERE id=?",
        )
        .bind(run.runId)
        .first<{
          status: string;
          org_id: string;
          grant_id: string;
          profile_id: string;
          deadline: number | null;
        }>();
      if (
        !pending ||
        pending.status !== "pending_approval" ||
        pending.org_id !== run.orgId ||
        pending.grant_id !== run.grantId ||
        pending.profile_id !== run.profileId ||
        pending.deadline !== run.deadline
      )
        throw new ControlError("forbidden", "Admission authority invalid", 403);
      if (source) await checkScope(source);
    };
    await freezeFiles(admissionContext, [artifact]);
    await db
      .prepare(
        "UPDATE control_runs SET status='running',lease_owner=? WHERE id=?",
      )
      .bind(context.claimId, RUN)
      .run();
    await expect(service.verifyInputs(context)).resolves.toBeUndefined();
    const file = await service.readForRun(
      context,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    expect(file.bytes.length).toBe(3);
    file.release();
  });
  it("durably freezes exact artifact metadata and target authority across service recreation", async () => {
    const artifact = await upload();
    const metadataDigest = await service.metadataDigest(
      context,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    const inputs = [
      {
        artifact_id: artifact.artifact_id,
        metadataDigest,
        targetRequirement: "target",
      },
    ];
    await service.freezeInputs(context, inputs);
    await service.freezeInputs(context, inputs);
    const row = await db
      .prepare(
        "SELECT refs_cipher,refs_digest FROM control_artifact_run_inputs WHERE run_id=?",
      )
      .bind(RUN)
      .first<{ refs_cipher: string; refs_digest: string }>();
    expect(row!.refs_cipher).not.toContain(artifact.artifact_id);
    expect(row!.refs_digest).toMatch(/^[a-f0-9]{64}$/);
    const recreated = createArtifactsService({
      database: { $client: db },
      secret,
      authority,
      now: () => clock,
    });
    await expect(recreated.verifyInputs(context)).resolves.toBeUndefined();
    await expect(
      recreated.freezeInputs(context, [
        { ...inputs[0]!, targetRequirement: null },
      ]),
    ).rejects.toMatchObject({ code: "invalid_arguments", status: 409 });
    await expect(
      db
        .prepare(
          "UPDATE control_artifact_run_inputs SET refs_digest=? WHERE run_id=?",
        )
        .bind("0".repeat(64), RUN)
        .run(),
    ).rejects.toThrow("artifact_run_inputs_immutable");
    targetDenied = true;
    await expect(recreated.verifyInputs(context)).rejects.toMatchObject({
      code: "broker_forbidden",
    });
    targetDenied = false;
    await db
      .prepare("UPDATE control_grants SET revoked_at=? WHERE id=?")
      .bind(clock, GRANT)
      .run();
    await expect(recreated.verifyInputs(context)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("rejects claimed/frozen metadata drift instead of silently replacing artifact inputs", async () => {
    const artifact = await service.createFromResponse(
      context,
      new Response(generated(3)),
      { mediaType: "application/octet-stream" },
    );
    const metadataDigest = await service.metadataDigest(
      context,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    await expect(
      service.freezeInputs(context, [
        {
          artifact_id: artifact.artifact_id,
          metadataDigest: "0".repeat(64),
          targetRequirement: "target",
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid_arguments", status: 409 });
    await service.freezeInputs(context, [
      {
        artifact_id: artifact.artifact_id,
        metadataDigest,
        targetRequirement: "target",
      },
    ]);
    clock += 1;
    await service.markRunCompleted(context, clock);
    await expect(service.verifyInputs(context)).rejects.toMatchObject({
      code: "invalid_arguments",
      status: 409,
    });
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments", status: 409 });
    await expect(
      service.withMultipartFiles(
        context,
        [{ artifact_id: artifact.artifact_id }],
        "target",
        async () => "unreachable",
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments", status: 409 });
  });
  it("authenticates persisted frozen-reference sets before reuse", async () => {
    const artifact = await upload();
    const metadataDigest = await service.metadataDigest(
      context,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    await service.freezeInputs(context, [
      {
        artifact_id: artifact.artifact_id,
        metadataDigest,
        targetRequirement: "target",
      },
    ]);
    await db.exec("DROP TRIGGER control_artifact_run_inputs_immutable");
    await db
      .prepare(
        "UPDATE control_artifact_run_inputs SET refs_cipher='invalid-public-cipher' WHERE run_id=?",
      )
      .bind(RUN)
      .run();
    await expect(service.verifyInputs(context)).rejects.toMatchObject({
      code: "internal_error",
    });
  });
  it("coordinates synchronous engine admission without treating owner reads as nested Run activity", async () => {
    let activeRun: string | null = RUN;
    const guarded = createArtifactsService({
      database: { $client: db },
      secret,
      authority,
      now: () => clock,
      canAcquireResource: (resource) =>
        activeRun === null || resource.runId === activeRun,
    });
    expect(binaryCapacityAvailable()).toBe(true);
    await expect(
      guarded.upload(owner, {
        profileId: PROFILE,
        grantId: GRANT,
        body: generated(3),
        mediaType: "application/octet-stream",
      }),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    let artifact: ArtifactRef | undefined;
    await guarded.withBinaryAdmission(context, async () => {
      expect(binaryCapacityAvailable()).toBe(false);
      artifact = await guarded.createFromResponse(
        context,
        new Response(generated(3)),
        { mediaType: "application/octet-stream" },
      );
      await expect(
        guarded.download(owner, artifact.artifact_id),
      ).rejects.toMatchObject({ code: "capacity_exceeded" });
    });
    expect(binaryCapacityAvailable()).toBe(true);
    await expect(
      guarded.download(owner, artifact!.artifact_id),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    activeRun = null;
    expect(
      new Uint8Array(
        await (
          await guarded.download(owner, artifact!.artifact_id)
        ).arrayBuffer(),
      ).length,
    ).toBe(3);
    expect(binaryCapacityAvailable()).toBe(true);
  });
  it("admits at most one large Run and requires release, including nested same-context buffers", async () => {
    const artifact = await upload(ARTIFACT_MAX_BYTES);
    await freezeFiles(context, [artifact]);
    const first = await service.readForRun(
      context,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    await expect(
      service.readForRun(
        { ...context },
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ code: "capacity_exceeded", status: 429 });
    await expect(
      service.readForRun(
        context,
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toMatchObject({ code: "capacity_exceeded", status: 429 });
    first.release();
    first.release();
    const next = await service.readForRun(
      context,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    next.release();
  }, 60000);
  it("accepts 10 files, rejects 11 and aggregate25MiB+1 before materializing or calling callback", async () => {
    const small = await upload(1);
    await freezeFiles(
      context,
      Array.from({ length: 10 }, () => small),
    );
    const callback = vi.fn(async (files: ArtifactFile[]) => files.length);
    expect(
      await service.withMultipartFiles(
        context,
        Array.from({ length: 10 }, () => ({ artifact_id: small.artifact_id })),
        "target",
        callback,
      ),
    ).toBe(10);
    await expect(
      service.withMultipartFiles(
        context,
        Array.from({ length: 11 }, () => ({ artifact_id: small.artifact_id })),
        "target",
        callback,
      ),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    const large = await upload(ARTIFACT_MAX_BYTES);
    await expect(
      service.withMultipartFiles(
        context,
        [
          { artifact_id: large.artifact_id },
          { artifact_id: small.artifact_id },
        ],
        "target",
        callback,
      ),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    expect(callback).toHaveBeenCalledTimes(1);
    let retained: Uint8Array | undefined;
    const largeRun = await newRunContext();
    await freezeFiles(largeRun, [large]);
    expect(
      await service.withMultipartFiles(
        largeRun,
        [{ artifact_id: large.artifact_id }],
        "target",
        async (files) => {
          retained = files[0]!.bytes;
          return files[0]!.ref.size_bytes;
        },
      ),
    ).toBe(ARTIFACT_MAX_BYTES);
    expect(retained!.every((byte) => byte === 0)).toBe(true);
    const failureRun = await newRunContext();
    await freezeFiles(failureRun, [small]);
    await expect(
      service.withMultipartFiles(
        failureRun,
        [{ artifact_id: small.artifact_id }],
        "target",
        async () => {
          throw new Error("public callback failure");
        },
      ),
    ).rejects.toThrow("public callback failure");
    await expect(upload()).resolves.toHaveProperty("artifact_id");
  }, 60000);
  it("counts actual decoded response bytes rather than trusting Content-Length", async () => {
    const response = new Response(generated(ARTIFACT_CHUNK_BYTES + 1), {
      headers: { "content-length": "1" },
    });
    const artifact = await service.createFromResponse(context, response, {
      mediaType: "application/octet-stream",
    });
    expect(artifact.size_bytes).toBe(ARTIFACT_CHUNK_BYTES + 1);
    await expect(
      service.createFromResponse(
        context,
        new Response(generated(3), { headers: { "content-encoding": "gzip" } }),
        { mediaType: "application/octet-stream" },
      ),
    ).rejects.toMatchObject({ code: "unsupported_result" });
  });
  it("retains pre-expiry inputs only through the active Run's existing deadline, never reviving them", async () => {
    const artifact = await upload();
    clock += ARTIFACT_RETENTION_MS - 1000;
    const retainedRun = crypto.randomUUID();
    const deadline = clock + 60000;
    await seedRun(retainedRun, GRANT, deadline);
    const originalCheck = authority.checkRun;
    authority.checkRun = async (run, source, requirement) => {
      if (run.runId !== retainedRun)
        return originalCheck(run, source, requirement);
      if (source) await checkScope(source);
    };
    const retainedContext = {
      ...context,
      runId: retainedRun,
      deadline,
      executionDeadline: deadline,
    };
    await freezeFiles(retainedContext, [artifact]);
    clock += 1000;
    await expect(
      service.download(caller, artifact.artifact_id),
    ).rejects.toMatchObject({ code: "content_expired" });
    expect((await service.cleanup()).chunks).toBe(0);
    const file = await service.readForRun(
      retainedContext,
      { artifact_id: artifact.artifact_id },
      "target",
    );
    file.release();
    await expect(
      service.readForRun(
        { ...retainedContext, runId: RUN },
        { artifact_id: artifact.artifact_id },
        "target",
      ),
    ).rejects.toBeInstanceOf(ControlError);
    clock = deadline;
    expect((await service.cleanup()).chunks).toBe(1);
    expect(
      (await service.auditMetadata(owner, artifact.artifact_id)).contentExpired,
    ).toBe(true);
  });
  it.each([false, true])(
    "pins Allow inputs only after the real claim without reviving expired queued content (late claim=%s)",
    async (expiredBeforeStart) => {
      const artifact = await upload();
      clock += ARTIFACT_RETENTION_MS - 1000;
      const running = {
        ...context,
        runId: crypto.randomUUID(),
        deadline: null,
        executionDeadline: clock + 60000,
      };
      await seedRun(running.runId, GRANT, null, running.executionDeadline);
      await db
        .prepare(
          "UPDATE control_runs SET status='queued',lease_owner=NULL,lease_until=NULL WHERE id=?",
        )
        .bind(running.runId)
        .run();
      const admission = { ...running, claimId: "admission" };
      const runningAuthority = authority.checkRun;
      authority.checkRun = async (run, source, requirement) => {
        if (run.claimId !== "admission")
          return runningAuthority(run, source, requirement);
        const row = await db
          .prepare(
            "SELECT status,deadline,lease_until FROM control_runs WHERE id=? AND org_id=? AND grant_id=? AND profile_id=?",
          )
          .bind(run.runId, run.orgId, run.grantId, run.profileId)
          .first<{
            status: string;
            deadline: number | null;
            lease_until: number | null;
          }>();
        if (
          !row ||
          row.status !== "queued" ||
          row.deadline !== null ||
          row.lease_until !== null
        )
          throw new ControlError(
            "forbidden",
            "Queued Allow authority invalid",
            403,
          );
        if (source) await checkScope(source);
      };
      await freezeFiles(admission, [artifact]);
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM control_artifact_inputs WHERE run_id=?",
          )
          .bind(running.runId)
          .first("count"),
      ).toBe(0);
      if (expiredBeforeStart) clock += 1000;
      await db
        .prepare(
          "UPDATE control_runs SET status='running',lease_owner=?,lease_until=? WHERE id=?",
        )
        .bind(running.claimId, running.executionDeadline, running.runId)
        .run();
      if (expiredBeforeStart) {
        await expect(service.verifyInputs(running)).rejects.toMatchObject({
          code: "content_expired",
          status: 410,
        });
        expect((await service.cleanup()).chunks).toBe(1);
        return;
      }
      await service.verifyInputs(running);
      expect(
        await db
          .prepare(
            "SELECT deadline FROM control_artifact_inputs WHERE run_id=?",
          )
          .bind(running.runId)
          .first("deadline"),
      ).toBe(running.executionDeadline);
      clock += 1000;
      expect((await service.cleanup()).chunks).toBe(0);
      const file = await service.readForRun(
        running,
        { artifact_id: artifact.artifact_id },
        "target",
      );
      file.release();
      clock = running.executionDeadline;
      expect((await service.cleanup()).chunks).toBe(1);
    },
  );
  it("bounds indefinite upload/read lifetime and releases large-binary admission on timeout", async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({ pull() {} });
    const pending = upload(0, { body: stalled });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "execution_timeout",
    });
    await vi.advanceTimersByTimeAsync(60000);
    await rejected;
    const artifact = await upload(3);
    const response = await service.download(caller, artifact.artifact_id);
    await vi.advanceTimersByTimeAsync(60000);
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "execution_timeout",
    });
    await expect(upload()).resolves.toHaveProperty("artifact_id");
  });
  it("starts seven-day output retention at authoritative producing Run completion", async () => {
    const artifact = await service.createFromResponse(
      context,
      new Response(generated(3)),
      { mediaType: "application/octet-stream" },
    );
    clock += 1000;
    expect(await service.markRunCompleted(context, clock)).toEqual([
      {
        ...artifact,
        expires_at: new Date(clock + ARTIFACT_RETENTION_MS).toISOString(),
      },
    ]);
    expect(
      (await service.auditMetadata(owner, artifact.artifact_id)).artifact
        .expires_at,
    ).toBe(new Date(clock + ARTIFACT_RETENTION_MS).toISOString());
  });
});
