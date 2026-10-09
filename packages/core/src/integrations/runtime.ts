import type { Database } from "@scaffold/database";
import {
  ArtifactRef,
  BusinessMcpResult,
  isJsonObject,
  type JSONValue,
  jsonProblem,
  type ReviewReport,
  type Source,
  type ToolDefinition,
} from "@scaffold/schema/integrations";
import {
  ControlError,
  createExecutionService,
  type ExecutionService,
  type IntegrationInvocation,
  type IntegrationRuntime,
} from "../execution/service";
import { parseStrictJson } from "../strict-json";
import { createAccountsService } from "./accounts";
import {
  type ArtifactRunContext,
  binaryCapacityAvailable,
  createArtifactsService,
} from "./artifacts";
import { createBroker } from "./broker";
import {
  createCatalogService,
  type ResolvedSource,
  type SourceResolver,
} from "./catalog";
import { createDerivedMetadataCounter } from "./derived-budget";
import {
  invokeHttpTool,
  resolveHttpTools,
  validateHttpArtifactInputs,
} from "./http";
import { createOAuthService } from "./oauth";
import { resolveOpenApiTools } from "./openapi";
import type { ProviderAdapter } from "./provider";
import {
  classifyRemoteManifestDrift,
  createRemoteMcpAdapter,
} from "./remote-mcp";
import type { IntegrationOwnerServices } from "./routes";
import {
  createTypeScriptSandbox,
  type QuickJSEngineFactory,
  type SandboxResult,
  type TypeScriptSandbox,
} from "./sandbox";
import { validateSchema } from "./schema";
import type { HttpTransport } from "./transport";
import { compileTypeScript } from "./typescript";
import type { CompiledTypeScriptArtifact } from "./typescript-artifact";

interface IntegrationServicesDependencies {
  db: Database;
  secret: string;
  transport: HttpTransport;
  providers: readonly ProviderAdapter[];
  now?: () => number;
}
export type IntegrationServicesOptions = IntegrationServicesDependencies &
  (
    | { engineFactory: QuickJSEngineFactory; sandbox?: never }
    | { sandbox: TypeScriptSandbox; engineFactory?: never }
  );
export interface IntegrationServices extends IntegrationOwnerServices {
  execution: ExecutionService;
  runtime: IntegrationRuntime;
}
// A resource permit, not a job queue. Losing schedulers leave unclaimed work in D1/SQLite.
let activeM2: { runId: string } | null = null;
export function createIntegrationServices(
  options: IntegrationServicesOptions,
): IntegrationServices {
  const now = options.now ?? Date.now,
    accounts = createAccountsService(options);
  const remote = createRemoteMcpAdapter({
    transport: options.transport,
    discoveryTransport: (owner, accountId) =>
      accounts.createOwnerTransport(owner, accountId),
    describeAuthentication: (owner, accountId, endpoint) =>
      accounts.describeRemoteAuthentication(owner, accountId, endpoint),
  });
  const sandbox =
    options.sandbox ??
    createTypeScriptSandbox({ engineFactory: options.engineFactory, now });
  const sources: SourceResolver = {
    async resolveTools(source: Source, owner): Promise<ResolvedSource> {
      if (source.kind === "remote_mcp")
        return remote.resolveTools(source, owner);
      if (source.kind === "openapi") {
        const resolved = await resolveOpenApiTools(source, {
          slug: owner.slug,
          transport: options.transport,
          validateSecurityMapping: (scheme, requirement) =>
            accounts.validateSecurityMapping(scheme, requirement),
        });
        return {
          accepted: resolved.accepted,
          rejected: resolved.rejected,
          diagnostics: resolved.diagnostics,
          snapshot: {
            manifest: resolved.manifest,
            warnings: resolved.warnings,
          },
        };
      }
      if (source.kind === "http") {
        const resolved = await resolveHttpTools(source);
        const accepted: ToolDefinition[] = [],
          rejected = [...resolved.rejected];
        for (const tool of resolved.accepted)
          try {
            for (const requirement of Object.values(tool.requirements))
              accounts.validateRequirement(requirement);
            accepted.push(tool);
          } catch (error) {
            rejected.push({
              upstreamName: tool.upstreamName ?? tool.name,
              path: "/requirements",
              code:
                error instanceof ControlError ? error.code : "import_invalid",
              message: "The native Provider requirement is unsupported.",
            });
          }
        return {
          accepted,
          rejected,
          diagnostics: resolved.diagnostics,
          snapshot: { warnings: resolved.warnings },
        };
      }
      const accepted: ToolDefinition[] = [],
        rejected: ReviewReport["rejected"] = [],
        compiled: Record<string, CompiledTypeScriptArtifact> =
          Object.create(null),
        diagnostics: Record<string, unknown> = Object.create(null);
      const reviewDiagnostics: NonNullable<ReviewReport["diagnostics"]> = [];
      const derived = createDerivedMetadataCounter();
      for (const [index, tool] of source.tools.entries()) {
        const schema = validateSchema(tool.inputSchema, {
            direction: "request",
          }),
          output =
            tool.outputSchema === undefined
              ? null
              : validateSchema(tool.outputSchema, { direction: "response" });
        const issue = [...schema.issues, ...(output?.issues ?? [])][0];
        if (issue) {
          rejected.push({
            upstreamName: tool.upstreamName ?? tool.name,
            path: issue.schemaPath,
            code: issue.code,
            message: issue.message,
          });
          continue;
        }
        try {
          for (const requirement of Object.values(tool.requirements))
            accounts.validateRequirement(requirement);
        } catch (error) {
          rejected.push({
            upstreamName: tool.upstreamName ?? tool.name,
            path: "/requirements",
            code: error instanceof ControlError ? error.code : "import_invalid",
            message: "The native Provider requirement is unsupported.",
          });
          continue;
        }
        for (const warning of schema.warnings) {
          const diagnostic = {
            upstreamName: tool.upstreamName ?? tool.name,
            path: "/tools/" + index + "/inputSchema" + warning.schemaPath,
            code: "schema_warning" as const,
            message: warning.message,
          };
          derived.add(diagnostic);
          reviewDiagnostics.push(diagnostic);
        }
        for (const warning of output?.warnings ?? []) {
          const diagnostic = {
            upstreamName: tool.upstreamName ?? tool.name,
            path: "/tools/" + index + "/outputSchema" + warning.schemaPath,
            code: "schema_warning" as const,
            message: warning.message,
          };
          derived.add(diagnostic);
          reviewDiagnostics.push(diagnostic);
        }
        if (tool.implementation.kind !== "typescript")
          throw new ControlError(
            "import_invalid",
            "The authored source kind does not match its implementation.",
          );
        const compilation = await compileTypeScript(tool.implementation);
        diagnostics[tool.name] = compilation.diagnostics;
        if (!compilation.valid) {
          const diagnostic = compilation.diagnostics[0];
          rejected.push({
            upstreamName: tool.upstreamName ?? tool.name,
            path: "/implementation/source",
            code: diagnostic?.code ?? "unsupported_feature",
            message:
              diagnostic?.message ??
              "The TypeScript source cannot be compiled safely.",
          });
          continue;
        }
        derived.add(tool);
        accepted.push(tool);
        compiled[tool.name] = compilation.artifact;
      }
      return {
        accepted,
        rejected,
        diagnostics: reviewDiagnostics,
        snapshot: { compiled, diagnostics },
      };
    },
  };
  const catalog = createCatalogService({
    ...options,
    sources,
    accounts,
    remoteDrift: classifyRemoteManifestDrift,
  });
  const oauth = createOAuthService({
    ...options,
    accounts,
    previewImpact: (owner, input) => catalog.previewOAuthImpact(owner, input),
  });
  let execution: ExecutionService;
  const artifacts = createArtifactsService({
    database: options.db,
    secret: options.secret,
    now,
    canAcquireResource: (resource) =>
      !activeM2 || resource.runId === activeM2.runId,
    authority: {
      checkAccess: (...args) => execution.authorizeArtifactAccess(...args),
      checkRun: (...args) => execution.authorizeArtifactRun(...args),
    },
  });
  const context = (input: IntegrationInvocation): ArtifactRunContext => ({
    orgId: input.orgId,
    profileId: input.profileId,
    grantId: input.grantId,
    runId: input.runId,
    claimId: input.claimId,
    deadline: input.retentionDeadline,
    executionDeadline: input.deadlineMs,
    selectedAccounts: input.selections,
  });
  const runtime: IntegrationRuntime = {
    catalog,
    accounts,
    tryAcquire(runId) {
      if (activeM2 || !binaryCapacityAvailable()) return null;
      const permit = { runId };
      activeM2 = permit;
      return () => {
        if (activeM2 === permit) activeM2 = null;
      };
    },
    async prepare(input) {
      const refs =
        input.tool.definition.implementation.kind === "http"
          ? await validateHttpArtifactInputs({
              tool: input.tool.definition,
              arguments: input.arguments,
              artifacts: { service: artifacts, context: context(input) },
            })
          : [];
      await artifacts.freezeInputs(context(input), refs);
    },
    async finalizeResult(input, result, at) {
      const refs = await artifacts.markRunCompleted(context(input), at),
        byId = new Map(refs.map((ref) => [ref.artifact_id, ref]));
      if (!byId.size) return result;
      let changes = 0;
      function replace(value: JSONValue): JSONValue {
        if (Array.isArray(value)) return value.map(replace);
        if (value !== null && typeof value === "object") {
          const artifact = ArtifactRef.safeParse(value);
          if (artifact.success && byId.has(artifact.data.artifact_id)) {
            changes++;
            return byId.get(artifact.data.artifact_id)!;
          }
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, replace(child)]),
          );
        }
        return value;
      }
      const content = result.content.map((block) => {
        try {
          const parsed = parseStrictJson(block.text),
            before = changes;
          if (!jsonProblem(parsed)) {
            const updated = replace(parsed as JSONValue);
            if (changes !== before)
              return { type: "text" as const, text: JSON.stringify(updated) };
          }
        } catch {}
        return block;
      });
      return BusinessMcpResult.parse({
        ...result,
        content,
        ...(result.structuredContent
          ? { structuredContent: replace(result.structuredContent) }
          : {}),
      });
    },
    async invokeTool(input) {
      const controller = new AbortController(),
        remaining = input.deadlineMs - now();
      if (remaining <= 0)
        throw new ControlError(
          "execution_timeout",
          "The immutable execution deadline has expired.",
          409,
          input.runId,
        );
      const timer = setTimeout(() => controller.abort(), remaining),
        runContext = context(input);
      const broker = createBroker({
        transport: options.transport,
        accounts,
        orgId: input.orgId,
        principalId: input.principalId,
        requirements: input.tool.definition.requirements,
        selections: input.selections,
        permissions: input.tool.definition.permissions,
        signal: controller.signal,
        beforeRequest: input.beforeRequest,
        requestHeaders:
          input.tool.definition.implementation.kind === "http"
            ? input.tool.definition.implementation.parameters
                .filter((parameter) => parameter.in === "header")
                .map((parameter) => parameter.name)
            : [],
        withBinaryAdmission: (callback) =>
          artifacts.withBinaryAdmission(runContext, callback),
        artifact: (response) =>
          artifacts.createFromResponse(runContext, response, {
            mediaType:
              response.headers.get("content-type") ??
              "application/octet-stream",
          }),
      });
      try {
        await artifacts.verifyInputs(runContext);
        let outcome: SandboxResult;
        switch (input.tool.definition.implementation.kind) {
          case "http":
            outcome = await invokeHttpTool({
              ...input,
              broker,
              artifacts: { service: artifacts, context: runContext },
            });
            break;
          case "remote_mcp":
            outcome = await remote.invokeTool({ ...input, broker });
            break;
          case "typescript": {
            const retained = await catalog.snapshot(
              input.orgId,
              input.tool.integrationRevision,
            );
            if (
              !isJsonObject(retained.snapshot) ||
              !isJsonObject(retained.snapshot.compiled)
            )
              throw new ControlError(
                "tool_unavailable",
                "The retained compiled artifact is unavailable.",
                409,
                input.runId,
              );
            const artifact = retained.snapshot.compiled[input.tool.name];
            if (!isJsonObject(artifact))
              throw new ControlError(
                "tool_unavailable",
                "The retained compiled artifact is unavailable.",
                409,
                input.runId,
              );
            // Integrity verification in the sandbox validates the complete immutable artifact before loading.
            const compiledArtifact =
              artifact as unknown as CompiledTypeScriptArtifact;
            outcome = await sandbox.invoke({
              artifact: compiledArtifact,
              artifactDigest: input.tool.artifactDigest,
              arguments: input.arguments,
              deadlineMs: input.deadlineMs,
              broker,
              signal: controller.signal,
              outputSchema: input.tool.definition.outputSchema,
              onLogs: input.onLogs,
            });
            break;
          }
        }
        const result = BusinessMcpResult.safeParse(outcome.result);
        if (!result.success)
          throw Object.assign(
            new ControlError(
              "unsupported_result",
              "The upstream result is not supported by the retained MCP contract.",
              502,
              input.runId,
            ),
            { effect: outcome.effect },
          );
        return { ...outcome, result: result.data };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
    async cleanup() {
      await catalog.cleanup();
      await artifacts.cleanup();
      await accounts.cleanup();
      await oauth.cleanup();
    },
    async completed(input, at) {
      await artifacts.markRunCompleted(context(input), at);
    },
  };
  execution = createExecutionService({ ...options, runtime });
  return { execution, runtime, catalog, accounts, oauth, artifacts };
}
