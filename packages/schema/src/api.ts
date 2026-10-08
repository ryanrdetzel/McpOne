import { z } from "zod";

/** Zod is the single source: these schemas feed runtime validation AND OpenAPI. */
export const Health = z.object({ ok: z.boolean(), release: z.string() });
export const DatabaseStatus = z.object({ ok: z.boolean() });

/** Local scaffold status only; no product data or user information. */
export const DashboardStatus = z.object({
  appSlug: z.string(),
  release: z.string(),
  database: z.boolean(),
});
export type DashboardStatus = z.infer<typeof DashboardStatus>;

/** Feature-flag admin — the operator's mutation path. */
export const FlagSet = z.object({
  key: z.string().min(1).max(100),
  enabled: z.boolean(),
  rolloutPct: z.number().int().min(0).max(100).default(100),
});
export type FlagSet = z.infer<typeof FlagSet>;
