import {
  hasCodeUnitInRange,
  isJsonObject,
  jsonProblem,
  TYPESCRIPT_ENTRY_MODULE,
} from "@scaffold/schema/integrations";
import { canonicalJson, sha256 } from "../execution/canonical.js";

export const TYPESCRIPT_COMPILER_VERSION = "5.9.3" as const;
export const QUICKJS_RUNTIME_VERSION = "0.32.0" as const;
export const TYPESCRIPT_LIMITS = Object.freeze({
  entryBytes: 262144,
  sourceBytes: 1048576,
  modules: 32,
  artifactBytes: 1048576,
});
export const ENTRY_MODULE = `/${TYPESCRIPT_ENTRY_MODULE}` as const;
export interface CompiledTypeScriptArtifact {
  version: 1;
  compilerVersion: typeof TYPESCRIPT_COMPILER_VERSION;
  runtimeVersion: typeof QUICKJS_RUNTIME_VERSION;
  entryModule: typeof ENTRY_MODULE;
  entrypoint: string;
  modules: Readonly<Record<string, string>>;
  sourceDigest: string;
  artifactDigest: string;
}

export function resolveTypeScriptModule(
  base: string,
  specifier: string,
): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    throw new Error("Only relative immutable .ts imports are supported");
  if (
    !/^(?:\.\.?\/)+[a-zA-Z0-9_./-]+\.ts$/.test(specifier) ||
    specifier.includes("\\") ||
    specifier.includes("%") ||
    specifier.includes("?") ||
    specifier.includes("#") ||
    hasCodeUnitInRange(specifier, 0, 32)
  )
    throw new Error("A relative .ts import is required");
  const parts = base.slice(1).split("/");
  parts.pop();
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (!parts.length)
        throw new Error("Module path escapes the source closure");
      parts.pop();
    } else {
      if (!part || part === "." || part === "..")
        throw new Error("Invalid module path");
      parts.push(part);
    }
  }
  return "/" + parts.join("/");
}
export function moduleId(path: string): string {
  const cleaned = path.startsWith("./") ? path.slice(2) : path;
  if (
    cleaned.length > 256 ||
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.ts$/.test(cleaned) ||
    cleaned.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("A safe relative .ts module path is required");
  return "/" + cleaned;
}

/** Integrity check only: Runs never compile, resolve packages or substitute newer source. */
export async function verifyCompiledTypeScriptArtifact(
  artifact: CompiledTypeScriptArtifact,
  expectedDigest: string,
): Promise<boolean> {
  if (
    !isJsonObject(artifact) ||
    !isJsonObject(artifact.modules) ||
    jsonProblem(artifact, TYPESCRIPT_LIMITS.artifactBytes) ||
    artifact.version !== 1 ||
    artifact.compilerVersion !== TYPESCRIPT_COMPILER_VERSION ||
    artifact.runtimeVersion !== QUICKJS_RUNTIME_VERSION ||
    artifact.entryModule !== ENTRY_MODULE ||
    !/^(?:default|[a-zA-Z_$][a-zA-Z0-9_$]*)$/.test(artifact.entrypoint) ||
    !/^[a-f0-9]{64}$/.test(artifact.sourceDigest) ||
    artifact.artifactDigest !== expectedDigest
  )
    return false;
  const keys = Object.keys(artifact.modules);
  if (
    !keys.length ||
    keys.length > TYPESCRIPT_LIMITS.modules ||
    !Object.hasOwn(artifact.modules, artifact.entryModule) ||
    keys.some((key) => {
      try {
        return (
          key !== moduleId(key.slice(1)) ||
          typeof artifact.modules[key] !== "string"
        );
      } catch {
        return true;
      }
    })
  )
    return false;
  const { artifactDigest, ...frame } = artifact;
  return artifactDigest === (await sha256(canonicalJson(frame)));
}
