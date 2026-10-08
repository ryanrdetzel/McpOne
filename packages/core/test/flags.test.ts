import type { Database } from "@scaffold/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlagService, rolloutBucket } from "../src/flags";

function flagDatabase(
  rows: { key: string; enabled: boolean; rolloutPct: number }[],
) {
  const from = vi.fn().mockResolvedValue(rows);
  const db = { select: () => ({ from }) } as unknown as Database;
  return { db, from };
}

afterEach(() => vi.useRealTimers());

describe("rollout bucketing", () => {
  it("stays stable inside 1..100", () => {
    for (const id of [
      "user@example.com",
      "org_alpha",
      "",
      "a",
      "sample-user",
    ]) {
      const bucket = rolloutBucket(id);
      expect(bucket).toBeGreaterThanOrEqual(1);
      expect(bucket).toBeLessThanOrEqual(100);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(rolloutBucket(id)).toBe(bucket);
    }
  });
});

describe("application-scoped flags", () => {
  it("enforces enabled state and rollout thresholds; default callers need 100%", async () => {
    const { db } = flagDatabase([
      { key: "partial", enabled: true, rolloutPct: 50 },
      { key: "full", enabled: true, rolloutPct: 100 },
      { key: "off", enabled: false, rolloutPct: 100 },
    ]);
    const flags = createFlagService(db);
    expect(await flags.flagEnabled("partial")).toBe(false);
    expect(await flags.flagEnabled("partial", 50)).toBe(true);
    expect(await flags.flagEnabled("partial", 51)).toBe(false);
    expect(await flags.flagEnabled("full")).toBe(true);
    expect(await flags.flagEnabled("off", 1)).toBe(false);
    expect(await flags.flagEnabled("absent")).toBe(false);
  });

  it("expires within ten seconds and invalidates immediately after writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { db, from } = flagDatabase([
      { key: "flag", enabled: true, rolloutPct: 100 },
    ]);
    const flags = createFlagService(db);
    expect(await flags.flagEnabled("flag")).toBe(true);
    vi.setSystemTime(9_999);
    expect(await flags.flagEnabled("flag")).toBe(true);
    expect(from).toHaveBeenCalledTimes(1);
    from.mockResolvedValue([{ key: "flag", enabled: false, rolloutPct: 100 }]);
    vi.setSystemTime(10_000);
    expect(await flags.flagEnabled("flag")).toBe(false);
    expect(from).toHaveBeenCalledTimes(2);
    from.mockResolvedValue([{ key: "flag", enabled: true, rolloutPct: 100 }]);
    flags.invalidateFlagCache();
    expect(await flags.flagEnabled("flag")).toBe(true);
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("does not share flags between application databases", async () => {
    const first = createFlagService(
      flagDatabase([{ key: "flag", enabled: true, rolloutPct: 100 }]).db,
    );
    const second = createFlagService(
      flagDatabase([{ key: "flag", enabled: false, rolloutPct: 100 }]).db,
    );
    expect(await first.flagEnabled("flag")).toBe(true);
    expect(await second.flagEnabled("flag")).toBe(false);
    second.invalidateFlagCache();
    expect(await first.flagEnabled("flag")).toBe(true);
  });

  it("does not cache an earlier read after invalidation", async () => {
    const { db, from } = flagDatabase([]);
    const { promise, resolve } =
      Promise.withResolvers<
        { key: string; enabled: boolean; rolloutPct: number }[]
      >();
    from.mockReturnValueOnce(promise);
    const flags = createFlagService(db);
    const pending = flags.flagEnabled("flag");
    flags.invalidateFlagCache();
    resolve([{ key: "flag", enabled: true, rolloutPct: 100 }]);
    await pending;
    from.mockResolvedValue([{ key: "flag", enabled: false, rolloutPct: 100 }]);
    expect(await flags.flagEnabled("flag")).toBe(false);
    expect(from).toHaveBeenCalledTimes(2);
  });
});
