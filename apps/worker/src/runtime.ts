import type {
  D1Database,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { parseEnv } from "@scaffold/config";
import type { Application } from "@scaffold/core";
import { createExecutionService } from "@scaffold/core/execution";
import { createDatabase } from "@scaffold/database";
import type { ControlScheduler } from "./control-scheduler";

/** Only the standard fetch surface is used; core retains portable Web API types. */
interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Bindings extends Record<string, unknown> {
  DB: D1Database;
  ASSETS: AssetBinding;
  CONTROL_SCHEDULER: DurableObjectNamespace<ControlScheduler>;
}

interface Runtime {
  env: ReturnType<typeof parseEnv>;
  db: ReturnType<typeof createDatabase>;
  execution: ReturnType<typeof createExecutionService>;
  app?: Application;
}

const runtimes = new WeakMap<Bindings, Runtime>();

export function runtime(bindings: Bindings): Runtime {
  const cached = runtimes.get(bindings);
  if (cached) return cached;
  const env = parseEnv(bindings);
  const db = createDatabase(bindings.DB);
  const execution = createExecutionService({
    db,
    secret: env.BETTER_AUTH_SECRET,
  });
  const context = { env, db, execution };
  runtimes.set(bindings, context);
  return context;
}
