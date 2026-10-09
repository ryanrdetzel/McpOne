import type { Database } from "@scaffold/database";
import { GatewayCreateConnectionInput } from "@scaffold/schema/gateway";
import {
  hasCodeUnitInRange,
  isJsonObject,
  jsonProblem,
} from "@scaffold/schema/integrations";
import { ControlError } from "../execution/service";
import { parseStrictJson } from "../strict-json";
import { createCredentialProtection } from "./credential-protection";
import type { HttpTransport } from "./transport";

type Owner = { orgId: string; userId: string };
export interface ConnectionAuthorization {
  orgId: string;
  profileId: string;
  integrationId: string;
  credentialId: string;
  endpoint: string;
  headers: Headers;
}
export interface ConnectionCredentials {
  create(owner: Owner, endpoint: string, token: string): Promise<string>;
  ownerTransport(
    owner: Owner,
    id: string,
    endpoint: string,
  ): Promise<HttpTransport & { redact(text: string): string }>;
  authorize(
    input: ConnectionAuthorization,
  ): Promise<{ headers: Headers; redact(text: string): string }>;
}
const denied = () =>
  new ControlError(
    "forbidden",
    "The endpoint-bound workspace credential is unavailable.",
    403,
  );
export function createConnectionCredentials(options: {
  db: Database;
  secret: string;
  transport: HttpTransport;
  now?: () => number;
}): ConnectionCredentials {
  const client = options.db.$client,
    protection = createCredentialProtection(options.secret);
  async function load(orgId: string, id: string, endpoint: string) {
    const row = await client
      .prepare(
        "SELECT cipher FROM control_connection_credentials WHERE id=? AND org_id=? AND endpoint=?",
      )
      .bind(id, orgId, endpoint)
      .first<{ cipher: string }>();
    if (!row) throw denied();
    const value = await protection.decrypt<{ endpoint: string; token: string }>(
      orgId,
      id,
      1,
      "credential",
      row.cipher,
    );
    if (
      value.endpoint !== endpoint ||
      !GatewayCreateConnectionInput.safeParse({
        slug: "connection",
        displayName: "Connection",
        endpoint,
        bearerToken: value.token,
      }).success
    )
      throw denied();
    return value.token;
  }
  function inject(headers: Headers, token: string) {
    const result = new Headers(headers);
    if (result.has("authorization")) throw denied();
    result.set("authorization", `Bearer ${token}`);
    return {
      headers: result,
      redact: (text: string) => text.split(token).join("[redacted]"),
    };
  }
  return {
    async create(owner: Owner, endpoint: string, token: string) {
      if (
        !GatewayCreateConnectionInput.safeParse({
          slug: "connection",
          displayName: "Connection",
          endpoint,
          bearerToken: token,
        }).success
      )
        throw new ControlError(
          "invalid_request",
          "Canonical HTTPS endpoint and bearer token required.",
          400,
        );
      const id = crypto.randomUUID();
      const cipher = await protection.encrypt(
        owner.orgId,
        id,
        1,
        "credential",
        { endpoint, token },
      );
      await client
        .prepare(
          "INSERT INTO control_connection_credentials(id,org_id,endpoint,cipher,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(id, owner.orgId, endpoint, cipher, (options.now ?? Date.now)())
        .run();
      return id;
    },
    async ownerTransport(owner: Owner, id: string, endpoint: string) {
      const token = await load(owner.orgId, id, endpoint);
      const authorized = inject(new Headers(), token);
      return {
        redact: authorized.redact,
        async request(input: Parameters<HttpTransport["request"]>[0]) {
          if (
            input.url !== endpoint ||
            !["POST", "DELETE"].includes(input.method) ||
            input.maxResponseBytes < 0 ||
            input.maxResponseBytes > 1114112 ||
            (input.body?.byteLength ?? 0) > 1048576
          )
            throw denied();
          for (const [name, value] of input.headers) {
            if (
              ![
                "accept",
                "content-type",
                "accept-encoding",
                "mcp-session-id",
                "mcp-protocol-version",
                "last-event-id",
              ].includes(name) ||
              hasCodeUnitInRange(value, 0, 31) ||
              value.includes("\x7f") ||
              value.length > 8192 ||
              (name === "accept-encoding" && value !== "identity")
            )
              throw denied();
          }
          if (input.method === "POST") {
            let message: unknown;
            try {
              message = parseStrictJson(
                new TextDecoder("utf-8", { fatal: true }).decode(input.body),
              );
            } catch {
              throw denied();
            }
            if (
              !isJsonObject(message) ||
              jsonProblem(message) ||
              (message.method !== undefined
                ? ![
                    "initialize",
                    "tools/list",
                    "notifications/initialized",
                    "notifications/cancelled",
                  ].includes(String(message.method))
                : !Object.hasOwn(message, "id") ||
                  !Object.hasOwn(message, "error"))
            )
              throw denied();
          } else if (input.body !== undefined) throw denied();
          const currentToken = await load(owner.orgId, id, endpoint);
          const response = await options.transport.request({
            ...input,
            headers: inject(new Headers(input.headers), currentToken).headers,
          });
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new ControlError(
              "forbidden",
              "Endpoint-bound credentials cannot follow redirects.",
              403,
            );
          }
          return response;
        },
      };
    },
    async authorize(input) {
      // Publication explicitly shares a connection by selecting its immutable Tools in this Profile.
      // Resolve the credential reference from that selected source, never from caller or guest input.
      const selected = await client
        .prepare(`SELECT DISTINCT r.source_blob_id FROM control_profile_tools pt
        JOIN control_profiles p ON p.id=pt.profile_id JOIN control_tools t ON t.id=pt.tool_id
        JOIN control_integrations i ON i.id=t.integration_id AND i.org_id=p.org_id
        JOIN control_tool_revisions tr ON tr.tool_id=t.id AND tr.revision=coalesce(pt.tool_revision,t.active_revision)
        JOIN control_integration_revisions r ON r.id=tr.integration_revision_id
        WHERE p.id=? AND p.org_id=? AND p.enabled=1 AND pt.enabled=1 AND i.id=? AND i.enabled=1 AND r.available=1 AND r.status<>'draft'`)
        .bind(input.profileId, input.orgId, input.integrationId)
        .all<{ source_blob_id: string }>();
      let shared = false;
      for (const row of selected.results) {
        const chunks = await client
          .prepare(
            "SELECT content FROM control_catalog_chunks WHERE blob_id=? ORDER BY chunk_index",
          )
          .bind(row.source_blob_id)
          .all<{ content: string }>();
        const source = JSON.parse(
          chunks.results.map((chunk) => chunk.content).join(""),
        );
        if (
          source.kind === "remote_mcp" &&
          source.connectionCredentialId === input.credentialId &&
          source.endpoint === input.endpoint
        ) {
          shared = true;
          break;
        }
      }
      if (!shared) throw denied();
      return inject(
        input.headers,
        await load(input.orgId, input.credentialId, input.endpoint),
      );
    },
  };
}
