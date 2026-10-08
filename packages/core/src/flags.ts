import type { Database } from "@scaffold/database";
import { tables } from "@scaffold/schema";

const TTL_MS = 10_000;

export interface FlagService {
  flagEnabled(key: string, bucket?: number): Promise<boolean>;
  invalidateFlagCache(): void;
}

/** Stable 1..100 FNV-1a bucket: partial rollouts stay sticky per subject. */
export function rolloutBucket(subjectId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < subjectId.length; i++) {
    hash ^= subjectId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 100) + 1;
}

/** Each application owns its cache; writes invalidate only that application. */
export function createFlagService(db: Database): FlagService {
  let cache = new Map<string, { enabled: boolean; rolloutPct: number }>();
  let fetchedAt: number | undefined;
  let generation = 0;

  function invalidateFlagCache(): void {
    generation++;
    fetchedAt = undefined;
  }

  /** No subject means bucket 100, so only fully rolled-out flags pass. */
  async function flagEnabled(key: string, bucket = 100): Promise<boolean> {
    if (fetchedAt === undefined || Date.now() - fetchedAt >= TTL_MS) {
      const currentGeneration = generation;
      const rows = await db.select().from(tables.featureFlags);
      const fresh = new Map(
        rows.map((row) => [
          row.key,
          { enabled: row.enabled, rolloutPct: row.rolloutPct },
        ]),
      );
      // An earlier read must not repopulate a cache invalidated by a write.
      if (currentGeneration === generation) {
        cache = fresh;
        fetchedAt = Date.now();
      }
      const flag = fresh.get(key);
      return flag ? flag.enabled && bucket <= flag.rolloutPct : false;
    }
    const flag = cache.get(key);
    return flag ? flag.enabled && bucket <= flag.rolloutPct : false;
  }

  return { flagEnabled, invalidateFlagCache };
}
