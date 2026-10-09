import {
  ExecutionRequestMetadata,
  ExecutionResponseMetadata,
  McpRequestMeta,
  RunControl,
} from "@scaffold/schema/execution";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_NAMESPACE,
  fingerprintFixtures,
  metadataFixtures,
  resultMetadataFixtures,
} from "../../../scripts/m2-contract-fixtures.mjs";
import { canonicalJson, sha256 } from "../src/execution/canonical";

describe("D12 execution metadata compatibility", () => {
  for (const fixture of metadataFixtures) {
    it(fixture.name, () => {
      const result = ExecutionRequestMetadata.safeParse(fixture.value);
      expect(result.success).toBe(fixture.valid);
      if (result.success) expect(result.data).toEqual(fixture.value);
    });
  }
  for (const fixture of resultMetadataFixtures) {
    it(fixture.name, () => {
      expect(ExecutionResponseMetadata.safeParse(fixture.value).success).toBe(
        fixture.valid,
      );
    });
  }
  it("preserves third-party metadata without granting it execution authority", () => {
    const input = {
      "org.example/trace": {
        accounts: { provider: "untrusted" },
        id: "public",
      },
      [EXECUTION_NAMESPACE]: { idempotency_key: " Public Key " },
    };
    expect(McpRequestMeta.parse(input)).toEqual(input);
    expect(
      McpRequestMeta.safeParse({
        ...input,
        [EXECUTION_NAMESPACE]: { accounts: { provider: "untrusted" } },
      }).success,
    ).toBe(false);
  });
  it("keeps approval and errors out of minimal result metadata", () => {
    const value = {
      run_id: "run-public",
      tool: "sample.notes.write",
      accounts: { provider: "Personal notes" },
      status: "pending_approval",
      approval_url: "https://example.com/approvals/public",
    };
    expect(RunControl.safeParse(value).success).toBe(true);
    expect(ExecutionResponseMetadata.safeParse(value).success).toBe(false);
  });
});

describe("D12 canonical execution identity edge cases", () => {
  for (const fixture of fingerprintFixtures) {
    it(fixture.name, async () => {
      expect(canonicalJson(fixture.frame)).toBe(fixture.canonical);
      expect(await sha256(canonicalJson(fixture.frame))).toBe(fixture.sha256);
    });
  }
  const frame = {
    version: "m2",
    organization_id: "workspace-public",
    grant_id: "grant-public",
    profile_id: "profile-public",
    tool: "sample.notes.write",
    tool_revision: "revision-public-1",
    integration_revision: "integration-public-1",
    accounts: {
      target: {
        account_id: "account-public-1",
        identity_digest: "a".repeat(64),
      },
    },
    options: {},
    arguments: { value: 3, labels: ["first", "second"] },
  };
  it("ignores object insertion order at every depth, not Account identity", async () => {
    const reordered = {
      ...frame,
      arguments: { labels: ["first", "second"], value: 3 },
    };
    expect(await sha256(canonicalJson(reordered))).toBe(
      await sha256(canonicalJson(frame)),
    );
    for (const changed of [
      {
        ...frame,
        accounts: {
          target: {
            account_id: "account-public-2",
            identity_digest: "a".repeat(64),
          },
        },
      },
      {
        ...frame,
        accounts: {
          target: {
            account_id: "account-public-1",
            identity_digest: "b".repeat(64),
          },
        },
      },
      { ...frame, integration_revision: "integration-public-2" },
      { ...frame, tool_revision: "revision-public-2" },
      { ...frame, grant_id: "grant-public-2" },
      { ...frame, options: { method: "PUT" } },
      { ...frame, arguments: { value: "3", labels: ["first", "second"] } },
      { ...frame, arguments: { value: 3, labels: ["second", "first"] } },
    ]) {
      expect(await sha256(canonicalJson(changed))).not.toBe(
        await sha256(canonicalJson(frame)),
      );
    }
  });
  it("does not normalize printable caller IDs or Unicode business strings", () => {
    expect(
      ExecutionRequestMetadata.parse({ idempotency_key: " Key " }),
    ).toEqual({
      idempotency_key: " Key ",
    });
    expect(canonicalJson({ text: "é" })).not.toBe(
      canonicalJson({ text: "e\u0301" }),
    );
  });
  it("rejects invalid Unicode nested in arrays and property names", () => {
    expect(() => canonicalJson({ outer: [{ "\ud800": "public" }] })).toThrow();
    expect(() => canonicalJson({ outer: [{ text: "\udfff" }] })).toThrow();
  });
});
