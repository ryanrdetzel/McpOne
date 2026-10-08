import type { ApiType } from "@scaffold/core";
import { hc } from "hono/client";

/**
 * Hono RPC client — end-to-end types from the shared Zod schemas, no codegen.
 * Default is same-origin: the Worker serves the SPA, so relative URLs are correct
 * in production. VITE_API_URL exists for local frontend HMR on a second port.
 */
export const client = hc<ApiType>(import.meta.env.VITE_API_URL ?? "");
