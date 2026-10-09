import type {
  D1Database,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { type Env, parseEnv } from "@scaffold/config";
import type { Application } from "@scaffold/core";
import {
  createIntegrationServices,
  type IntegrationServices,
} from "@scaffold/core/integrations";
import { createGithubProvider } from "@scaffold/core/integrations/github";
import {
  SandboxError,
  type TypeScriptSandbox,
} from "@scaffold/core/integrations/sandbox";
import { createWasmTlsClient } from "@scaffold/core/integrations/tls";
import { createDatabase, type Database } from "@scaffold/database";
import tlsModule from "../dist/tls.wasm";
import caBundle from "../tls/cacert.pem";
import type { ControlScheduler } from "./control-scheduler";
import { createWorkerHttpTransport } from "./transport";

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
  env: Env;
  db: Database;
  execution: IntegrationServices["execution"];
  integrations: IntegrationServices;
  app?: Application;
}

const runtimes = new WeakMap<Bindings, Runtime>();

// Worker TypeScript execution is unavailable until native CPU isolation is accepted.
// Reject before inspecting or evaluating guest artifacts; the broker owns effects.
const unavailableTypeScriptSandbox: TypeScriptSandbox = {
  async invoke(input) {
    throw new SandboxError("tool_unavailable", input.broker.effect());
  },
};

export function runtime(bindings: Bindings): Runtime {
  const cached = runtimes.get(bindings);
  if (cached) return cached;
  const env = parseEnv(bindings);
  const db = createDatabase(bindings.DB);
  const controlUrl = new URL(env.BETTER_AUTH_URL);
  const transport = createWorkerHttpTransport(
    createWasmTlsClient({
      module: tlsModule,
      caBundle: new TextEncoder().encode(caBundle),
    }),
  );
  const integrations = createIntegrationServices({
    db,
    secret: env.BETTER_AUTH_SECRET,
    transport,
    sandbox: unavailableTypeScriptSandbox,
    providers: [
      createGithubProvider({
        transport,
        oauth:
          env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET
            ? {
                kind: env.GITHUB_OAUTH_REGISTRATION_KIND,
                clientId: env.GITHUB_OAUTH_CLIENT_ID,
                clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
                callbackUrl: new URL(
                  "/api/control/accounts/oauth/callback",
                  controlUrl,
                ).href,
                controlOrigin: controlUrl.origin,
                custody:
                  controlUrl.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(
                    controlUrl.hostname,
                  )
                    ? "local"
                    : "hosted",
              }
            : undefined,
      }),
    ],
  });
  const context = { env, db, execution: integrations.execution, integrations };
  runtimes.set(bindings, context);
  return context;
}
