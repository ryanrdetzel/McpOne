import type { D1Database } from "@cloudflare/workers-types";
import { sha256 as streamingSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  ArtifactInput,
  type ArtifactRef,
  ArtifactRef as ArtifactRefSchema,
  hasCodeUnitInRange,
  jsonProblem,
  type SelectedAccount,
  SelectedAccount as SelectedAccountSchema,
} from "@scaffold/schema/integrations";
import { canonicalJson, sha256 } from "../execution/canonical";
import { ControlError } from "../execution/service";
import { parseStrictJson } from "../strict-json";

export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const ARTIFACT_CHUNK_BYTES = 512 * 1024;
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SQL_CHUNK_BATCH = 4;
export const ARTIFACT_STAGING_MS = 60 * 60 * 1000;
const FORMAT = "mcpone-artifact-v1" as const;
const encoder = new TextEncoder();

export type ArtifactPrincipal =
  | { kind: "owner"; orgId: string; userId: string }
  | {
      kind: "grant";
      orgId: string;
      profileId: string;
      grantId: string;
      principalId: string | null;
    };
export interface ArtifactRunContext {
  orgId: string;
  grantId: string;
  profileId: string;
  runId: string;
  claimId: string;
  deadline: number | null;
  executionDeadline: number;
  selectedAccounts: Record<string, SelectedAccount>;
}
export interface ArtifactScope {
  artifactId: string;
  orgId: string;
  grantId: string;
  profileId: string;
  ownerUserId: string | null;
  runId: string | null;
  selectedAccounts: Record<string, SelectedAccount>;
}
export interface ArtifactProvenance extends ArtifactScope {
  format: typeof FORMAT;
  createdAt: number;
  completedAt: number;
  expiresAt: number;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  chunkCount: number;
  sha256: string;
}
export interface ArtifactAuthority {
  /** Authenticate the typed principal and recheck exact current Grant/Profile and producing Run/Accounts. */
  checkAccess(
    principal: ArtifactPrincipal,
    source: ArtifactScope,
    operation: "upload" | "read" | "audit",
  ): Promise<void>;
  /** Recheck current claim/epoch, all source Account identities, target selections, and explicit destination permission. */
  checkRun(
    context: ArtifactRunContext,
    source?: ArtifactProvenance,
    targetRequirement?: string | null,
  ): Promise<void>;
}
export interface ArtifactFile {
  ref: ArtifactRef;
  bytes: Uint8Array<ArrayBuffer>;
}
export interface ArtifactFrozenInput {
  artifact_id: string;
  metadataDigest: string;
  targetRequirement?: string | null;
}
interface NormalizedFrozenInput {
  artifact_id: string;
  metadataDigest: string;
  targetRequirement: string | null;
}
export interface ArtifactService {
  upload(
    principal: Extract<ArtifactPrincipal, { kind: "owner" }>,
    input: {
      profileId: string;
      grantId: string;
      body: ReadableStream<Uint8Array> | null;
      mediaType: string;
      filename?: string;
      contentEncoding?: string | null;
      contentLength?: string | null;
    },
  ): Promise<ArtifactRef>;
  createFromResponse(
    context: ArtifactRunContext,
    response: Response,
    input: { mediaType: string; filename?: string },
  ): Promise<ArtifactRef>;
  download(
    principal: ArtifactPrincipal,
    artifactId: string,
    options?: { method?: "GET" | "HEAD"; range?: string | null },
  ): Promise<Response>;
  auditMetadata(
    principal: ArtifactPrincipal,
    artifactId: string,
  ): Promise<{ artifact: ArtifactRef; contentExpired: boolean }>;
  metadataDigest(
    context: ArtifactRunContext,
    input: { artifact_id: string },
    targetRequirement: string | null,
  ): Promise<string>;
  freezeInputs(
    context: ArtifactRunContext,
    values: ArtifactFrozenInput[],
  ): Promise<void>;
  verifyInputs(context: ArtifactRunContext): Promise<void>;
  readForRun(
    context: ArtifactRunContext,
    input: { artifact_id: string },
    targetRequirement: string | null,
  ): Promise<ArtifactFile & { release(): void }>;
  withMultipartFiles<T>(
    context: ArtifactRunContext,
    inputs: { artifact_id: string }[],
    targetRequirement: string | null,
    callback: (files: ArtifactFile[]) => Promise<T>,
  ): Promise<T>;
  withBinaryAdmission<T>(
    context: ArtifactRunContext,
    callback: () => Promise<T>,
  ): Promise<T>;
  markRunCompleted(
    context: ArtifactRunContext,
    completedAt: number,
  ): Promise<ArtifactRef[]>;
  cleanup(options?: {
    maxArtifacts?: number;
    maxChunks?: number;
  }): Promise<{ artifacts: number; chunks: number; inputs: number }>;
}
interface ManifestRow {
  id: string;
  org_id: string;
  grant_id: string;
  profile_id: string;
  owner_user_id: string | null;
  run_id: string | null;
  state: "staging" | "ready";
  format: string;
  created_at: number;
  completed_at: number | null;
  staging_expires_at: number;
  expires_at: number | null;
  size_bytes: number | null;
  chunk_count: number | null;
  sha256: string | null;
  metadata_cipher: string | null;
  metadata_digest: string | null;
  content_deleted_at: number | null;
}
interface ChunkRow {
  chunk_index: number;
  plaintext_bytes: number;
  declared_size: number;
  ciphertext: ArrayBuffer | Uint8Array | number[];
}
function fail(
  code:
    | "invalid_request"
    | "invalid_arguments"
    | "not_found"
    | "forbidden"
    | "content_expired"
    | "payload_too_large"
    | "capacity_exceeded"
    | "internal_error"
    | "unsupported_result"
    | "execution_timeout",
  status: number,
  message: string,
): never {
  throw new ControlError(
    code,
    message,
    status,
    undefined,
    code === "capacity_exceeded",
  );
}
function corrupt(): never {
  return fail(
    "internal_error",
    500,
    "Protected artifact integrity could not be verified.",
  );
}
function id(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    fail("invalid_request", 400, "An artifact identifier must be a UUID.");
}
export function normalizeArtifactMediaType(value: string): string {
  if (
    value.length > 512 ||
    hasCodeUnitInRange(value, 0, 31) ||
    value.includes("\x7f")
  )
    fail("invalid_request", 400, "The artifact media type is invalid.");
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  if (
    type.length > 256 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
  )
    fail("invalid_request", 400, "The artifact media type is invalid.");
  return type;
}
export function sanitizeArtifactFilename(value = "artifact.bin"): string {
  // Filename/MIME never determine code trust. Remove separators, controls, bidi controls, and invalid Unicode.
  let safe = "";
  let length = 0;
  for (const scalar of value) {
    const cp = scalar.codePointAt(0)!;
    if (
      scalar === "/" ||
      scalar === "\\" ||
      cp < 32 ||
      (cp >= 127 && cp <= 159) ||
      (cp >= 0xd800 && cp <= 0xdfff) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069)
    )
      continue;
    if (length++ === 128) break;
    safe += scalar;
  }
  const basename = safe.trim();
  return !basename || basename === "." || basename === ".."
    ? "artifact.bin"
    : basename;
}
function ref(source: ArtifactProvenance): ArtifactRef {
  return {
    artifact_id: source.artifactId,
    media_type: source.mediaType,
    size_bytes: source.sizeBytes,
    sha256: source.sha256,
    filename: source.filename,
    expires_at: new Date(source.expiresAt).toISOString(),
  };
}
function binary(value: ChunkRow["ciphertext"]): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}
function toBase64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length > 64 * 1024) corrupt();
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return corrupt();
  }
}

/** One large-binary operation per isolate; admission rejects rather than adding a second Run queue. */
let binaryOwner: object | null = null;
export function binaryCapacityAvailable(): boolean {
  return binaryOwner === null;
}
export interface ArtifactResourceContext {
  runId?: string | null;
}
function acquire(
  context: object,
  canAcquireResource?: (context: ArtifactResourceContext) => boolean,
  resource: ArtifactResourceContext = {},
): () => void {
  if (
    binaryOwner !== null ||
    (canAcquireResource && !canAcquireResource(resource))
  )
    fail(
      "capacity_exceeded",
      429,
      "Large binary capacity is temporarily unavailable.",
    );
  binaryOwner = context;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      if (binaryOwner === context) binaryOwner = null;
    }
  };
}

export function createArtifactsService(options: {
  database: { readonly $client: D1Database };
  secret: string;
  authority: ArtifactAuthority;
  now?: () => number;
  canAcquireResource?: (context: ArtifactResourceContext) => boolean;
}): ArtifactService {
  if (!options.secret)
    throw new Error("Artifact protection requires a configured secret");
  const db = options.database.$client;
  const now = options.now ?? Date.now;
  const authority = options.authority;
  // Separate purpose from M1 execution payloads and Account credentials; no public runtime defaults.
  const key = crypto.subtle
    .digest(
      "SHA-256",
      encoder.encode(`mcpone/artifact/content/v1:${options.secret}`),
    )
    .then((raw) =>
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    );
  const metadataKey = crypto.subtle
    .digest(
      "SHA-256",
      encoder.encode(`mcpone/artifact/manifest/v1:${options.secret}`),
    )
    .then((raw) =>
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    );
  const inputsKey = crypto.subtle
    .digest(
      "SHA-256",
      encoder.encode(`mcpone/artifact/inputs/v1:${options.secret}`),
    )
    .then((raw) =>
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    );
  const activeContexts = new WeakMap<
    object,
    { users: number; release: () => void }
  >();
  let materializedBytes = 0;
  const materialized = new WeakMap<Uint8Array, number>();
  function allocate(size: number): Uint8Array<ArrayBuffer> {
    if (size > ARTIFACT_MAX_BYTES - materializedBytes)
      fail(
        "capacity_exceeded",
        429,
        "Large binary capacity is temporarily unavailable.",
      );
    const bytes = new Uint8Array(size);
    materializedBytes += size;
    materialized.set(bytes, size);
    return bytes;
  }
  function dispose(bytes: Uint8Array | undefined): void {
    if (!bytes) return;
    bytes.fill(0);
    const size = materialized.get(bytes);
    if (size !== undefined) {
      materializedBytes -= size;
      materialized.delete(bytes);
    }
  }
  function admission(context: ArtifactRunContext): () => void {
    const active = activeContexts.get(context);
    if (active) {
      active.users++;
      return () => {
        if (--active.users === 0) {
          activeContexts.delete(context);
          active.release();
        }
      };
    }
    const lease = {
      users: 1,
      release: acquire(context, options.canAcquireResource, {
        runId: context.runId,
      }),
    };
    activeContexts.set(context, lease);
    return () => {
      if (--lease.users === 0) {
        activeContexts.delete(context);
        lease.release();
      }
    };
  }
  async function seal(
    plain: Uint8Array<ArrayBuffer>,
    aad: string,
    encryptionKey: Promise<CryptoKey>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad) },
        await encryptionKey,
        plain,
      ),
    );
    const packed = new Uint8Array(12 + cipher.length);
    packed.set(nonce);
    packed.set(cipher, 12);
    return packed;
  }
  async function open(
    packed: Uint8Array<ArrayBuffer>,
    aad: string,
    encryptionKey: Promise<CryptoKey>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (packed.length < 28 || packed.length > ARTIFACT_CHUNK_BYTES + 28)
      corrupt();
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: packed.subarray(0, 12),
            additionalData: encoder.encode(aad),
          },
          await encryptionKey,
          packed.subarray(12),
        ),
      );
    } catch {
      return corrupt();
    }
  }
  const chunkAad = (
    scope: ArtifactScope,
    index: number,
    total: number,
    size: number,
  ) =>
    canonicalJson([FORMAT, scope.orgId, scope.artifactId, index, total, size]);
  const manifestAad = (orgId: string, artifactId: string) =>
    canonicalJson([FORMAT, "manifest", orgId, artifactId]);
  const inputsAad = (context: ArtifactRunContext) =>
    canonicalJson([
      FORMAT,
      "inputs",
      context.orgId,
      context.runId,
      context.grantId,
      context.profileId,
    ]);
  async function loadFrozenInputs(
    context: ArtifactRunContext,
  ): Promise<NormalizedFrozenInput[] | null> {
    const row = await db
      .prepare(
        "SELECT refs_cipher,refs_digest FROM control_artifact_run_inputs WHERE run_id=? AND org_id=? AND grant_id=? AND profile_id=?",
      )
      .bind(context.runId, context.orgId, context.grantId, context.profileId)
      .first<{ refs_cipher: string; refs_digest: string }>();
    if (!row) return null;
    try {
      const decoded = parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await open(
            fromBase64(row.refs_cipher),
            inputsAad(context),
            inputsKey,
          ),
        ),
      );
      if (jsonProblem(decoded, 16 * 1024)) corrupt();
      const inputs = normalizeFrozenInputs(decoded as ArtifactFrozenInput[]);
      const json = canonicalJson(inputs);
      if (
        canonicalJson(decoded) !== json ||
        (await sha256(json)) !== row.refs_digest
      )
        corrupt();
      return inputs;
    } catch {
      return corrupt();
    }
  }
  async function protectedManifest(
    source: ArtifactProvenance,
  ): Promise<{ cipher: string; digest: string }> {
    const json = canonicalJson(source);
    if (encoder.encode(json).length > 32 * 1024) corrupt();
    return {
      cipher: toBase64(
        await seal(
          encoder.encode(json),
          manifestAad(source.orgId, source.artifactId),
          metadataKey,
        ),
      ),
      digest: await sha256(json),
    };
  }
  async function decode(row: ManifestRow): Promise<ArtifactProvenance> {
    if (
      !row.metadata_cipher ||
      !row.metadata_digest ||
      row.state !== "ready" ||
      row.format !== FORMAT
    )
      corrupt();
    let source: ArtifactProvenance;
    try {
      source = parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await open(
            fromBase64(row.metadata_cipher),
            manifestAad(row.org_id, row.id),
            metadataKey,
          ),
        ),
      ) as ArtifactProvenance;
      if (jsonProblem(source, 32 * 1024)) corrupt();
      if ((await sha256(canonicalJson(source))) !== row.metadata_digest)
        corrupt();
      if (
        source.format !== FORMAT ||
        source.artifactId !== row.id ||
        source.orgId !== row.org_id ||
        source.grantId !== row.grant_id ||
        source.profileId !== row.profile_id ||
        source.ownerUserId !== row.owner_user_id ||
        source.runId !== row.run_id ||
        source.createdAt !== row.created_at ||
        source.completedAt !== row.completed_at ||
        source.expiresAt !== row.expires_at ||
        source.sizeBytes !== row.size_bytes ||
        source.chunkCount !== row.chunk_count ||
        source.sha256 !== row.sha256
      )
        corrupt();
      if (
        !ArtifactRefSchema.safeParse(ref(source)).success ||
        source.chunkCount !==
          Math.ceil(source.sizeBytes / ARTIFACT_CHUNK_BYTES) ||
        source.filename !== sanitizeArtifactFilename(source.filename) ||
        source.mediaType !== normalizeArtifactMediaType(source.mediaType)
      )
        corrupt();
      if (
        !source.selectedAccounts ||
        typeof source.selectedAccounts !== "object" ||
        Array.isArray(source.selectedAccounts) ||
        Object.keys(source.selectedAccounts).length > 8
      )
        corrupt();
      for (const [requirement, selected] of Object.entries(
        source.selectedAccounts,
      ))
        if (
          selected.requirement !== requirement ||
          !SelectedAccountSchema.safeParse(selected).success
        )
          corrupt();
      if (
        source.runId === null &&
        Object.keys(source.selectedAccounts).length !== 0
      )
        corrupt();
    } catch {
      return corrupt();
    }
    return source;
  }
  async function load(
    principal: ArtifactPrincipal,
    artifactId: string,
  ): Promise<{ row: ManifestRow; source: ArtifactProvenance }> {
    id(artifactId);
    const row =
      principal.kind === "grant"
        ? await db
            .prepare(
              "SELECT * FROM control_artifacts WHERE id=? AND org_id=? AND grant_id=? AND profile_id=? AND state='ready'",
            )
            .bind(
              artifactId,
              principal.orgId,
              principal.grantId,
              principal.profileId,
            )
            .first<ManifestRow>()
        : await db
            .prepare(
              "SELECT * FROM control_artifacts WHERE id=? AND org_id=? AND state='ready'",
            )
            .bind(artifactId, principal.orgId)
            .first<ManifestRow>();
    if (!row) fail("not_found", 404, "The requested artifact was not found.");
    return { row, source: await decode(row) };
  }
  function runPrincipal(context: ArtifactRunContext): ArtifactPrincipal {
    return {
      kind: "grant",
      orgId: context.orgId,
      profileId: context.profileId,
      grantId: context.grantId,
      principalId: null,
    };
  }
  async function current(
    context: ArtifactRunContext,
    source?: ArtifactProvenance,
    targetRequirement?: string | null,
  ): Promise<void> {
    if (context.executionDeadline <= now())
      fail(
        "forbidden",
        403,
        "The authorized Run execution deadline has expired.",
      );
    if (
      source &&
      (source.orgId !== context.orgId ||
        source.grantId !== context.grantId ||
        source.profileId !== context.profileId)
    )
      fail("not_found", 404, "The requested artifact was not found.");
    if (
      targetRequirement !== undefined &&
      targetRequirement !== null &&
      !Object.hasOwn(context.selectedAccounts, targetRequirement)
    )
      fail(
        "forbidden",
        403,
        "The target Account requirement is not selected for this Run.",
      );
    await authority.checkRun(context, source, targetRequirement);
  }
  async function isRetained(
    context: ArtifactRunContext,
    artifactId: string,
  ): Promise<boolean> {
    return !!(await db
      .prepare(
        "SELECT 1 AS retained FROM control_artifact_inputs i JOIN control_runs r ON r.id=i.run_id WHERE i.artifact_id=? AND i.run_id=? AND i.org_id=? AND i.grant_id=? AND i.profile_id=? AND r.deadline IS ? AND i.deadline>? AND i.deadline=coalesce(r.deadline,r.lease_until) AND r.status IN ('pending_approval','queued','running')",
      )
      .bind(
        artifactId,
        context.runId,
        context.orgId,
        context.grantId,
        context.profileId,
        context.deadline,
        now(),
      )
      .first());
  }
  async function checkedInput(
    context: ArtifactRunContext,
    input: { artifact_id: string },
    targetRequirement: string | null,
  ): Promise<{ row: ManifestRow; source: ArtifactProvenance }> {
    if (!ArtifactInput.safeParse(input).success)
      fail(
        "invalid_arguments",
        400,
        "A file input must contain only a valid artifact_id.",
      );
    await current(context, undefined, targetRequirement);
    const loaded = await load(runPrincipal(context), input.artifact_id);
    await current(context, loaded.source, targetRequirement);
    if (
      loaded.row.content_deleted_at !== null ||
      (loaded.source.expiresAt <= now() &&
        !(await isRetained(context, input.artifact_id)))
    )
      fail("content_expired", 410, "Protected artifact content has expired.");
    if (loaded.source.expiresAt > now()) {
      // Retention never revives expired content or moves a Run's immutable deadline.
      await db
        .prepare(
          "INSERT INTO control_artifact_inputs (artifact_id,run_id,org_id,grant_id,profile_id,deadline,created_at) SELECT a.id,r.id,r.org_id,r.grant_id,r.profile_id,coalesce(r.deadline,r.lease_until),? FROM control_artifacts a JOIN control_runs r ON r.id=? WHERE a.id=? AND a.org_id=? AND a.grant_id=? AND a.profile_id=? AND r.org_id=a.org_id AND r.grant_id=a.grant_id AND r.profile_id=a.profile_id AND r.deadline IS ? AND r.status IN ('pending_approval','queued','running') AND coalesce(r.deadline,r.lease_until)>? AND a.state='ready' AND a.expires_at>? AND a.content_deleted_at IS NULL ON CONFLICT(artifact_id,run_id) DO NOTHING",
        )
        .bind(
          now(),
          context.runId,
          input.artifact_id,
          context.orgId,
          context.grantId,
          context.profileId,
          context.deadline,
          now(),
          now(),
        )
        .run();
    }
    return loaded;
  }
  async function chunkBatch(
    artifactId: string,
    start: number,
  ): Promise<ChunkRow[]> {
    const rows = await db
      .prepare(
        "SELECT chunk_index,plaintext_bytes,declared_size,ciphertext FROM control_artifact_chunks WHERE artifact_id=? AND chunk_index>=? AND chunk_index<? ORDER BY chunk_index LIMIT 4",
      )
      .bind(artifactId, start, start + SQL_CHUNK_BATCH)
      .all<ChunkRow>();
    return rows.results;
  }
  async function verifyChunks(
    source: ArtifactProvenance,
    collect: boolean,
  ): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const summary = await db
      .prepare(
        "SELECT count(*) AS count, coalesce(sum(plaintext_bytes),0) AS size FROM control_artifact_chunks WHERE artifact_id=?",
      )
      .bind(source.artifactId)
      .first<{ count: number; size: number }>();
    if (
      !summary ||
      summary.count !== source.chunkCount ||
      summary.size !== source.sizeBytes
    )
      corrupt();
    const output = collect ? allocate(source.sizeBytes) : undefined;
    const hash = streamingSha256.create();
    try {
      let offset = 0;
      for (let start = 0; start < source.chunkCount; start += SQL_CHUNK_BATCH) {
        const chunks = await chunkBatch(source.artifactId, start);
        if (
          chunks.length !== Math.min(SQL_CHUNK_BATCH, source.chunkCount - start)
        )
          corrupt();
        for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
          const index = start + ordinal;
          const chunk = chunks[ordinal]!;
          const expected = Math.min(
            ARTIFACT_CHUNK_BYTES,
            source.sizeBytes - offset,
          );
          if (
            chunk.chunk_index !== index ||
            chunk.plaintext_bytes !== expected ||
            chunk.declared_size !== source.sizeBytes
          )
            corrupt();
          const packed = binary(chunk.ciphertext);
          if (packed.length !== expected + 28) corrupt();
          const plain = await open(
            packed,
            chunkAad(source, index, source.sizeBytes, expected),
            key,
          );
          try {
            if (plain.length !== expected) corrupt();
            hash.update(plain);
            output?.set(plain, offset);
            offset += plain.length;
          } finally {
            plain.fill(0);
          }
        }
      }
      if (
        offset !== source.sizeBytes ||
        bytesToHex(hash.digest()) !== source.sha256
      )
        corrupt();
      return output;
    } catch (error) {
      dispose(output);
      throw error;
    } finally {
      hash.destroy();
    }
  }
  async function create(
    scope: ArtifactScope,
    body: ReadableStream<Uint8Array> | null,
    mediaType: string,
    filename: string,
    recheck: () => Promise<void>,
    bodyDeadline = now() + 60000,
    contentLength?: string | null,
  ): Promise<ArtifactRef> {
    const createdAt = now();
    const stagingExpiresAt = createdAt + ARTIFACT_STAGING_MS;
    const hint =
      contentLength &&
      contentLength.length <= 16 &&
      /^(0|[1-9][0-9]*)$/.test(contentLength)
        ? Number(contentLength)
        : -1;
    const declared =
      Number.isSafeInteger(hint) && hint >= 0 && hint <= ARTIFACT_MAX_BYTES
        ? hint
        : -1;
    const pending: {
      index: number;
      size: number;
      bytes: Uint8Array<ArrayBuffer>;
    }[] = [];
    const verified = streamingSha256.create();
    const liveStage =
      "SELECT 1 FROM control_artifacts a JOIN control_grants g ON g.id=a.grant_id JOIN control_profiles p ON p.id=a.profile_id WHERE a.id=? AND a.state='staging' AND a.staging_expires_at>? AND g.org_id=a.org_id AND g.profile_id=a.profile_id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?) AND p.enabled=1";
    await recheck();
    await db
      .prepare(
        "INSERT INTO control_artifacts (id,org_id,grant_id,profile_id,owner_user_id,run_id,state,format,created_at,staging_expires_at) VALUES (?,?,?,?,?,?,'staging',?,?,?)",
      )
      .bind(
        scope.artifactId,
        scope.orgId,
        scope.grantId,
        scope.profileId,
        scope.ownerUserId,
        scope.runId,
        FORMAT,
        createdAt,
        stagingExpiresAt,
      )
      .run();
    let total = 0;
    let index = 0;
    const hash = streamingSha256.create();
    const buffer = new Uint8Array(ARTIFACT_CHUNK_BYTES);
    let buffered = 0;
    const reader = body?.getReader();
    async function readBody(): Promise<ReadableStreamReadResult<Uint8Array>> {
      const remaining = Math.min(60000, bodyDeadline - now());
      if (remaining <= 0)
        fail(
          "execution_timeout",
          502,
          "The finite artifact body deadline expired.",
        );
      const { promise, resolve, reject } =
        Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
      const timer = setTimeout(
        () =>
          reject(
            new ControlError(
              "execution_timeout",
              "The finite artifact body deadline expired.",
              502,
            ),
          ),
        remaining,
      );
      reader!.read().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
      return promise;
    }
    async function flushChunks(): Promise<void> {
      if (!pending.length) return;
      if (now() >= stagingExpiresAt)
        fail(
          "content_expired",
          410,
          "The interrupted artifact upload expired.",
        );
      if (scope.runId !== null && now() >= bodyDeadline)
        fail(
          "execution_timeout",
          502,
          "The authorized artifact processing deadline expired.",
        );
      // At most four BLOB rows, never one large row or a whole-artifact D1 request.
      const sql = `WITH live AS (${liveStage}) INSERT INTO control_artifact_chunks (artifact_id,chunk_index,plaintext_bytes,declared_size,ciphertext) ${pending.map(() => "SELECT ?,?,?,?,? FROM live").join(" UNION ALL ")}`;
      const values = pending.flatMap((chunk) => [
        scope.artifactId,
        chunk.index,
        chunk.size,
        declared,
        chunk.bytes,
      ]);
      const written = await db
        .prepare(sql)
        .bind(scope.artifactId, now(), now(), ...values)
        .run();
      if (written.meta.changes !== pending.length) {
        await recheck();
        corrupt();
      }
      pending.length = 0;
    }
    async function writeChunk(): Promise<void> {
      if (!buffered) return;
      const plain = buffer.subarray(0, buffered);
      pending.push({
        index,
        size: buffered,
        bytes: await seal(
          plain,
          chunkAad(scope, index, declared, buffered),
          key,
        ),
      });
      index++;
      buffered = 0;
      buffer.fill(0);
      if (pending.length === SQL_CHUNK_BATCH) await flushChunks();
    }
    try {
      if (reader) {
        while (true) {
          const item = await readBody();
          if (item.done) break;
          if (!(item.value instanceof Uint8Array))
            fail(
              "invalid_request",
              400,
              "The artifact body must contain binary bytes.",
            );
          if (item.value.byteLength > ARTIFACT_MAX_BYTES - total)
            fail("payload_too_large", 413, "An artifact cannot exceed 25 MiB.");
          total += item.value.byteLength;
          hash.update(item.value);
          for (let offset = 0; offset < item.value.byteLength; ) {
            const take = Math.min(
              ARTIFACT_CHUNK_BYTES - buffered,
              item.value.byteLength - offset,
            );
            buffer.set(item.value.subarray(offset, offset + take), buffered);
            buffered += take;
            offset += take;
            if (buffered === ARTIFACT_CHUNK_BYTES) await writeChunk();
          }
        }
      }
      await writeChunk();
      await flushChunks();
      const digest = bytesToHex(hash.digest());
      // Count actual bytes; advisory/unknown length can never authorize or truncate content.
      for (let start = 0; start < index; start += SQL_CHUNK_BATCH) {
        if (now() >= stagingExpiresAt)
          fail(
            "content_expired",
            410,
            "The interrupted artifact upload expired.",
          );
        if (scope.runId !== null && now() >= bodyDeadline)
          fail(
            "execution_timeout",
            502,
            "The authorized artifact processing deadline expired.",
          );
        const chunks = await chunkBatch(scope.artifactId, start);
        if (chunks.length !== Math.min(SQL_CHUNK_BATCH, index - start))
          corrupt();
        const rebound: { index: number; bytes: Uint8Array<ArrayBuffer> }[] = [];
        for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
          const chunkIndex = start + ordinal;
          const chunk = chunks[ordinal]!;
          const expected = Math.min(
            ARTIFACT_CHUNK_BYTES,
            total - chunkIndex * ARTIFACT_CHUNK_BYTES,
          );
          if (
            chunk.chunk_index !== chunkIndex ||
            chunk.plaintext_bytes !== expected ||
            chunk.declared_size !== declared
          )
            corrupt();
          const plain = await open(
            binary(chunk.ciphertext),
            chunkAad(scope, chunkIndex, declared, expected),
            key,
          );
          try {
            if (plain.length !== expected) corrupt();
            verified.update(plain);
            if (declared !== total)
              rebound.push({
                index: chunkIndex,
                bytes: await seal(
                  plain,
                  chunkAad(scope, chunkIndex, total, expected),
                  key,
                ),
              });
          } finally {
            plain.fill(0);
          }
        }
        if (rebound.length) {
          const cases = rebound.map(() => "WHEN ? THEN ?").join(" ");
          const indexes = rebound.map(() => "?").join(",");
          const values = rebound.flatMap((chunk) => [chunk.index, chunk.bytes]);
          const updated = await db
            .prepare(
              `UPDATE control_artifact_chunks SET declared_size=?,ciphertext=CASE chunk_index ${cases} END WHERE artifact_id=? AND chunk_index IN (${indexes}) AND declared_size=? AND EXISTS (${liveStage})`,
            )
            .bind(
              total,
              ...values,
              scope.artifactId,
              ...rebound.map((chunk) => chunk.index),
              declared,
              scope.artifactId,
              now(),
              now(),
            )
            .run();
          if (updated.meta.changes !== rebound.length) {
            await recheck();
            corrupt();
          }
        }
      }
      if (bytesToHex(verified.digest()) !== digest) corrupt();
      await recheck();
      const completedAt = now();
      const source: ArtifactProvenance = {
        ...scope,
        format: FORMAT,
        createdAt,
        completedAt,
        expiresAt: completedAt + ARTIFACT_RETENTION_MS,
        mediaType,
        filename,
        sizeBytes: total,
        chunkCount: index,
        sha256: digest,
      };
      const manifest = await protectedManifest(source);
      const ready = await db
        .prepare(
          "UPDATE control_artifacts SET state='ready',completed_at=?,expires_at=?,size_bytes=?,chunk_count=?,sha256=?,metadata_cipher=?,metadata_digest=? WHERE id=? AND state='staging' AND staging_expires_at>? AND (SELECT count(*) FROM control_artifact_chunks WHERE artifact_id=?)=? AND (SELECT coalesce(sum(plaintext_bytes),0) FROM control_artifact_chunks WHERE artifact_id=?)=? AND NOT EXISTS (SELECT 1 FROM control_artifact_chunks WHERE artifact_id=? AND (declared_size<>? OR chunk_index>=? OR plaintext_bytes<>min(524288,?-chunk_index*524288))) AND EXISTS (SELECT 1 FROM control_grants g JOIN control_profiles p ON p.id=g.profile_id WHERE g.id=control_artifacts.grant_id AND g.org_id=control_artifacts.org_id AND g.profile_id=control_artifacts.profile_id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?) AND p.enabled=1)",
        )
        .bind(
          completedAt,
          source.expiresAt,
          total,
          index,
          digest,
          manifest.cipher,
          manifest.digest,
          scope.artifactId,
          now(),
          scope.artifactId,
          index,
          scope.artifactId,
          total,
          scope.artifactId,
          total,
          index,
          total,
          now(),
        )
        .run();
      if (ready.meta.changes !== 1) {
        await recheck();
        corrupt();
      }
      return ref(source);
    } catch (error) {
      try {
        void reader?.cancel().catch(() => {});
      } catch {
        /* Shared drain removes interrupted staging. */
      }
      if (error instanceof ControlError) throw error;
      return fail(
        "internal_error",
        500,
        "The artifact could not be stored safely.",
      );
    } finally {
      buffer.fill(0);
      pending.length = 0;
      hash.destroy();
      verified.destroy();
      reader?.releaseLock();
    }
  }
  async function verifyFrozenInputSet(
    context: ArtifactRunContext,
    inputs: NormalizedFrozenInput[],
  ): Promise<void> {
    let total = 0;
    for (const input of inputs) {
      const { row, source } = await checkedInput(
        context,
        { artifact_id: input.artifact_id },
        input.targetRequirement,
      );
      if (row.metadata_digest !== input.metadataDigest)
        fail(
          "invalid_arguments",
          409,
          "The frozen artifact input metadata changed.",
        );
      total += source.sizeBytes;
      if (total > ARTIFACT_MAX_BYTES)
        fail(
          "payload_too_large",
          413,
          "Multipart file bytes cannot exceed 25 MiB in aggregate.",
        );
    }
  }
  async function withBinaryAdmission<T>(
    context: ArtifactRunContext,
    callback: () => Promise<T>,
  ): Promise<T> {
    const release = admission(context);
    try {
      await current(context);
      return await callback();
    } finally {
      release();
    }
  }
  return {
    async upload(principal, input) {
      if (principal.kind !== "owner")
        fail(
          "forbidden",
          403,
          "Owner authentication is required to upload an artifact.",
        );
      if (
        input.contentEncoding &&
        input.contentEncoding.trim().toLowerCase() !== "identity"
      )
        fail(
          "invalid_request",
          415,
          "Compressed artifact uploads are unsupported.",
        );
      const mediaType = normalizeArtifactMediaType(input.mediaType);
      const filename = sanitizeArtifactFilename(input.filename);
      const scope: ArtifactScope = {
        artifactId: crypto.randomUUID(),
        orgId: principal.orgId,
        grantId: input.grantId,
        profileId: input.profileId,
        ownerUserId: principal.userId,
        runId: null,
        selectedAccounts: {},
      };
      const release = acquire(scope, options.canAcquireResource, {
        runId: null,
      });
      try {
        return await create(
          scope,
          input.body,
          mediaType,
          filename,
          () => authority.checkAccess(principal, scope, "upload"),
          undefined,
          input.contentLength,
        );
      } catch (error) {
        try {
          void input.body?.cancel().catch(() => {});
        } catch {
          /* A failed reader already canceled the body. */
        }
        throw error;
      } finally {
        release();
      }
    },
    async createFromResponse(context, response, input) {
      const release = admission(context);
      try {
        const encoding = response.headers.get("content-encoding");
        if (encoding && encoding.toLowerCase() !== "identity")
          fail(
            "unsupported_result",
            502,
            "The binary response must be decoded by the trusted transport.",
          );
        if (
          !context.selectedAccounts ||
          Object.keys(context.selectedAccounts).length > 8 ||
          Object.entries(context.selectedAccounts).some(
            ([requirement, selected]) =>
              selected.requirement !== requirement ||
              !SelectedAccountSchema.safeParse(selected).success,
          )
        )
          fail("forbidden", 403, "The frozen Account selections are invalid.");
        const scope: ArtifactScope = {
          artifactId: crypto.randomUUID(),
          orgId: context.orgId,
          grantId: context.grantId,
          profileId: context.profileId,
          ownerUserId: null,
          runId: context.runId,
          selectedAccounts: structuredClone(context.selectedAccounts),
        };
        return await create(
          scope,
          response.body,
          normalizeArtifactMediaType(input.mediaType),
          sanitizeArtifactFilename(input.filename),
          () => current(context),
          context.executionDeadline,
          response.headers.get("content-length"),
        );
      } catch (error) {
        try {
          void response.body?.cancel().catch(() => {});
        } catch {
          /* Reader ownership may already have canceled it. */
        }
        throw error;
      } finally {
        release();
      }
    },
    async download(principal, artifactId, downloadOptions = {}) {
      const { row, source } = await load(principal, artifactId);
      await authority.checkAccess(principal, source, "read");
      if (source.expiresAt <= now() || row.content_deleted_at !== null)
        fail("content_expired", 410, "Protected artifact content has expired.");
      const headers = new Headers({
        "content-type": source.mediaType,
        "content-length": String(source.sizeBytes),
        "content-disposition": attachment(source.filename),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "accept-ranges": "none",
      });
      if (
        downloadOptions.range !== undefined &&
        downloadOptions.range !== null
      ) {
        headers.delete("content-length");
        return new Response(null, { status: 416, headers });
      }
      const release = acquire(source, options.canAcquireResource, {
        runId: null,
      });
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        bytes = await verifyChunks(source, downloadOptions.method !== "HEAD");
        await authority.checkAccess(principal, source, "read");
        if (source.expiresAt <= now())
          fail(
            "content_expired",
            410,
            "Protected artifact content has expired.",
          );
        if (!bytes || bytes.length === 0) {
          dispose(bytes);
          release();
          return new Response(null, { headers });
        }
        const stored = bytes;
        let offset = 0;
        let closed = false;
        let stopTimer = () => {};
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const finish = () => {
          if (!closed) {
            closed = true;
            stopTimer();
            dispose(stored);
            release();
          }
        };
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              streamController = controller;
            },
            async pull(controller) {
              try {
                await authority.checkAccess(principal, source, "read");
                if (source.expiresAt <= now())
                  fail(
                    "content_expired",
                    410,
                    "Protected artifact content has expired.",
                  );
                if (closed) return;
              } catch (error) {
                finish();
                controller.error(error);
                return;
              }
              if (offset === stored.length) {
                finish();
                controller.close();
                return;
              }
              // Queue at most one internal chunk; never give a view into bytes that will be wiped.
              const end = Math.min(
                offset + ARTIFACT_CHUNK_BYTES,
                stored.length,
              );
              controller.enqueue(stored.slice(offset, end));
              offset = end;
            },
            cancel() {
              finish();
            },
          },
          { highWaterMark: 0 },
        );
        const timer = setTimeout(() => {
          finish();
          streamController.error(
            new ControlError(
              "execution_timeout",
              "The artifact transfer deadline expired.",
              502,
            ),
          );
        }, 60000);
        stopTimer = () => clearTimeout(timer);
        return new Response(body, { headers });
      } catch (error) {
        dispose(bytes);
        release();
        throw error;
      }
    },
    async auditMetadata(principal, artifactId) {
      const { row, source } = await load(principal, artifactId);
      await authority.checkAccess(principal, source, "audit");
      return {
        artifact: ref(source),
        contentExpired:
          source.expiresAt <= now() || row.content_deleted_at !== null,
      };
    },
    async metadataDigest(context, input, targetRequirement) {
      const { row, source } = await checkedInput(
        context,
        input,
        targetRequirement,
      );
      await current(context, source, targetRequirement);
      return row.metadata_digest!;
    },
    async freezeInputs(context, values) {
      const inputs = normalizeFrozenInputs(values);
      await current(context);
      await verifyFrozenInputSet(context, inputs);
      const json = canonicalJson(inputs);
      const digest = await sha256(json);
      const cipher = toBase64(
        await seal(encoder.encode(json), inputsAad(context), inputsKey),
      );
      await current(context);
      await db
        .prepare(
          "INSERT INTO control_artifact_run_inputs (run_id,org_id,grant_id,profile_id,refs_cipher,refs_digest,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM control_runs WHERE id=? AND org_id=? AND grant_id=? AND profile_id=? AND deadline IS ? AND status IN ('pending_approval','queued','running')) ON CONFLICT(run_id) DO NOTHING",
        )
        .bind(
          context.runId,
          context.orgId,
          context.grantId,
          context.profileId,
          cipher,
          digest,
          now(),
          context.runId,
          context.orgId,
          context.grantId,
          context.profileId,
          context.deadline,
        )
        .run();
      const frozen = await loadFrozenInputs(context);
      if (!frozen) {
        await current(context);
        fail(
          "forbidden",
          403,
          "The artifact inputs could not be frozen under the current Run authority.",
        );
      }
      if (canonicalJson(frozen) !== json)
        fail(
          "invalid_arguments",
          409,
          "The immutable artifact input set cannot be changed.",
        );
    },
    async verifyInputs(context) {
      await current(context);
      const inputs = await loadFrozenInputs(context);
      if (!inputs) corrupt();
      await verifyFrozenInputSet(context, inputs);
    },
    async readForRun(context, input, targetRequirement) {
      const release = admission(context);
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        const { row, source } = await checkedInput(
          context,
          input,
          targetRequirement,
        );
        const frozen = await loadFrozenInputs(context);
        if (!frozen) corrupt();
        const pinned = frozen.find(
          (part) =>
            part.artifact_id === input.artifact_id &&
            part.targetRequirement === targetRequirement,
        );
        if (!pinned || pinned.metadataDigest !== row.metadata_digest)
          fail(
            "invalid_arguments",
            409,
            "This artifact is not the frozen input for the selected target requirement.",
          );
        bytes = (await verifyChunks(source, true))!;
        await current(context, source, targetRequirement);
        const stored = bytes;
        let released = false;
        return {
          ref: ref(source),
          bytes: stored,
          release() {
            if (!released) {
              released = true;
              dispose(stored);
              release();
            }
          },
        };
      } catch (error) {
        dispose(bytes);
        release();
        throw error;
      }
    },
    async withMultipartFiles(context, inputs, targetRequirement, callback) {
      if (!Array.isArray(inputs) || inputs.length > 10)
        fail(
          "payload_too_large",
          413,
          "A multipart invocation cannot contain more than 10 files.",
        );
      const release = admission(context);
      const files: ArtifactFile[] = [];
      try {
        const sources: ArtifactProvenance[] = [];
        const consumed: NormalizedFrozenInput[] = [];
        let total = 0;
        // Authenticate every part and calculate aggregate before allocating any file buffer.
        for (const input of inputs) {
          const { row, source } = await checkedInput(
            context,
            input,
            targetRequirement,
          );
          total += source.sizeBytes;
          if (total > ARTIFACT_MAX_BYTES)
            fail(
              "payload_too_large",
              413,
              "Multipart file bytes cannot exceed 25 MiB in aggregate.",
            );
          sources.push(source);
          consumed.push({
            artifact_id: source.artifactId,
            metadataDigest: row.metadata_digest!,
            targetRequirement,
          });
        }
        const frozen = await loadFrozenInputs(context);
        if (!frozen) corrupt();
        if (
          canonicalJson(normalizeFrozenInputs(consumed)) !==
          canonicalJson(frozen)
        )
          fail(
            "invalid_arguments",
            409,
            "The multipart files differ from this Run's immutable artifact input set.",
          );
        for (const source of sources) {
          const bytes = (await verifyChunks(source, true))!;
          files.push({ ref: ref(source), bytes });
          await current(context, source, targetRequirement);
        }
        await current(context, undefined, targetRequirement);
        return await callback(files);
      } finally {
        for (const file of files) dispose(file.bytes);
        release();
      }
    },
    withBinaryAdmission,
    async markRunCompleted(context, completedAt) {
      await current(context);
      if (
        !Number.isSafeInteger(completedAt) ||
        completedAt > now() ||
        completedAt < 0
      )
        fail("invalid_request", 400, "The completion timestamp is invalid.");
      const rows = await db
        .prepare(
          "SELECT * FROM control_artifacts WHERE org_id=? AND run_id=? AND state='ready' LIMIT 31",
        )
        .bind(context.orgId, context.runId)
        .all<ManifestRow>();
      if (rows.results.length > 30) corrupt();
      const completed: ArtifactRef[] = [];
      for (const row of rows.results) {
        const source = await decode(row);
        if (completedAt < source.completedAt)
          fail(
            "invalid_request",
            400,
            "Run completion cannot precede artifact completion.",
          );
        const updated = {
          ...source,
          completedAt,
          expiresAt: completedAt + ARTIFACT_RETENTION_MS,
        };
        const manifest = await protectedManifest(updated);
        await current(context, source);
        const result = await db
          .prepare(
            "UPDATE control_artifacts SET completed_at=?,expires_at=?,metadata_cipher=?,metadata_digest=? WHERE id=? AND org_id=? AND state='ready' AND metadata_digest=? AND content_deleted_at IS NULL",
          )
          .bind(
            completedAt,
            updated.expiresAt,
            manifest.cipher,
            manifest.digest,
            row.id,
            row.org_id,
            row.metadata_digest,
          )
          .run();
        if (result.meta.changes !== 1) corrupt();
        completed.push(ref(updated));
      }
      return completed;
    },
    async cleanup(cleanupOptions = {}) {
      const maxArtifacts = bounded(cleanupOptions.maxArtifacts ?? 8, 1, 16);
      const maxChunks = bounded(cleanupOptions.maxChunks ?? 64, 1, 128);
      const clock = now();
      const staleInputs = await db
        .prepare(
          "DELETE FROM control_artifact_inputs WHERE rowid IN (SELECT i.rowid FROM control_artifact_inputs i JOIN control_runs r ON r.id=i.run_id WHERE i.deadline<=? OR r.status NOT IN ('pending_approval','queued','running') LIMIT ?)",
        )
        .bind(clock, maxChunks)
        .run();
      const candidates = await db
        .prepare(
          "SELECT a.* FROM control_artifacts a WHERE (a.state='staging' AND a.staging_expires_at<=?) OR (a.state='ready' AND a.expires_at<=? AND a.content_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM control_artifact_inputs i JOIN control_runs r ON r.id=i.run_id WHERE i.artifact_id=a.id AND i.deadline>? AND coalesce(r.deadline,r.lease_until)=i.deadline AND r.status IN ('pending_approval','queued','running'))) ORDER BY (a.state='staging') DESC,coalesce(a.cleanup_checked_at,0),coalesce(a.expires_at,a.staging_expires_at),a.id LIMIT ?",
        )
        .bind(clock, clock, clock, maxArtifacts)
        .all<ManifestRow>();
      let chunks = 0;
      let artifacts = 0;
      for (const row of candidates.results) {
        if (row.state === "ready") {
          try {
            const source = await decode(row);
            if (source.expiresAt > clock) continue;
          } catch (error) {
            if (
              !(error instanceof ControlError) ||
              error.code !== "internal_error"
            )
              throw error;
            // Unauthenticated expiry never authorizes deletion or poisons the shared Run drain.
            await db
              .prepare(
                "UPDATE control_artifacts SET cleanup_checked_at=? WHERE id=? AND state='ready' AND content_deleted_at IS NULL",
              )
              .bind(clock, row.id)
              .run();
            continue;
          }
        }
        if (chunks >= maxChunks) break;
        // No cascade can turn this bounded deletion into an unbounded binary D1 request.
        const deleted = await db
          .prepare(
            "DELETE FROM control_artifact_chunks WHERE artifact_id=? AND chunk_index IN (SELECT chunk_index FROM control_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index LIMIT ?) AND EXISTS (SELECT 1 FROM control_artifacts a WHERE a.id=? AND ((a.state='staging' AND a.staging_expires_at<=?) OR (a.state='ready' AND a.expires_at<=? AND NOT EXISTS (SELECT 1 FROM control_artifact_inputs i JOIN control_runs r ON r.id=i.run_id WHERE i.artifact_id=a.id AND i.deadline>? AND coalesce(r.deadline,r.lease_until)=i.deadline AND r.status IN ('pending_approval','queued','running')))))",
          )
          .bind(row.id, row.id, maxChunks - chunks, row.id, clock, clock, clock)
          .run();
        chunks += deleted.meta.changes;
        if (row.state === "staging") {
          const removed = await db
            .prepare(
              "DELETE FROM control_artifacts WHERE id=? AND state='staging' AND staging_expires_at<=? AND NOT EXISTS (SELECT 1 FROM control_artifact_chunks WHERE artifact_id=?)",
            )
            .bind(row.id, clock, row.id)
            .run();
          artifacts += removed.meta.changes;
        } else {
          const removed = await db
            .prepare(
              "UPDATE control_artifacts SET content_deleted_at=? WHERE id=? AND state='ready' AND expires_at<=? AND content_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM control_artifact_chunks WHERE artifact_id=?) AND NOT EXISTS (SELECT 1 FROM control_artifact_inputs i JOIN control_runs r ON r.id=i.run_id WHERE i.artifact_id=control_artifacts.id AND i.deadline>? AND coalesce(r.deadline,r.lease_until)=i.deadline AND r.status IN ('pending_approval','queued','running'))",
            )
            .bind(clock, row.id, clock, row.id, clock)
            .run();
          artifacts += removed.meta.changes;
        }
      }
      return { artifacts, chunks, inputs: staleInputs.meta.changes };
    },
  };
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("invalid_request", 400, "The cleanup work bound is invalid.");
  return value;
}
function normalizeFrozenInputs(
  values: ArtifactFrozenInput[],
): NormalizedFrozenInput[] {
  if (
    !Array.isArray(values) ||
    values.length > 10 ||
    jsonProblem(values, 16 * 1024)
  )
    fail("invalid_arguments", 400, "The frozen artifact input set is invalid.");
  const inputs = values.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).some(
        (key) =>
          key !== "artifact_id" &&
          key !== "metadataDigest" &&
          key !== "targetRequirement",
      ) ||
      !ArtifactInput.safeParse({ artifact_id: value.artifact_id }).success ||
      typeof value.metadataDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.metadataDigest)
    )
      fail("invalid_arguments", 400, "The frozen artifact input is invalid.");
    const targetRequirement = value.targetRequirement ?? null;
    if (
      targetRequirement !== null &&
      (typeof targetRequirement !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(targetRequirement))
    )
      fail(
        "invalid_arguments",
        400,
        "The frozen artifact target requirement is invalid.",
      );
    return {
      artifact_id: value.artifact_id,
      metadataDigest: value.metadataDigest,
      targetRequirement,
    };
  });
  // Canonical ordering makes equivalent file-reference sets stable without discarding repeated parts.
  inputs.sort((a, b) => {
    const left = `${a.artifact_id}:${a.targetRequirement ?? ""}:${a.metadataDigest}`;
    const right = `${b.artifact_id}:${b.targetRequirement ?? ""}:${b.metadataDigest}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return inputs;
}
function attachment(filename: string): string {
  const ascii = Array.from(filename, (character) =>
    /[a-zA-Z0-9._ -]/.test(character) ? character : "_",
  ).join("");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
