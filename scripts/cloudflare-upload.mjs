import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const home = process.env.CFL_CLIENT_HOME;
if (!home) {
  console.error(
    "Set CFL_CLIENT_HOME to the built cloudflare-lifecycle-mcp checkout.",
  );
  process.exit(1);
}
const moduleUrl = (name) => pathToFileURL(resolve(home, "dist/src", name)).href;
const [
  { loadRemoteConfig, uploadProject },
  { snapshotProject, loadSecrets },
  { failureOf, LifecycleError },
  { MAX_HOSTED_ARTIFACT_BYTES },
] = await Promise.all([
  import(moduleUrl("remote.js")),
  import(moduleUrl("project.js")),
  import(moduleUrl("errors.js")),
  import(moduleUrl("artifact.js")),
]);

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new LifecycleError(
      "invalid_arguments",
      "Use no arguments to upload, or --check to validate locally.",
    );
  }
  if (!Number.isSafeInteger(MAX_HOSTED_ARTIFACT_BYTES)) {
    throw new LifecycleError(
      "builder_upgrade_required",
      "Rebuild the lifecycle checkout with chunked hosted artifact support.",
    );
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const snapshot = await snapshotProject(root);
  await Promise.all([
    loadSecrets(snapshot, false),
    loadSecrets(snapshot, true),
  ]);
  const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (serializedBytes > MAX_HOSTED_ARTIFACT_BYTES) {
    throw new LifecycleError(
      "artifact_too_large",
      `Artifact is ${serializedBytes} serialized bytes; hosted limit is ${MAX_HOSTED_ARTIFACT_BYTES}.`,
    );
  }
  if (args[0] === "--check") {
    console.log(
      JSON.stringify({ ok: true, digest: snapshot.digest, serializedBytes }),
    );
  } else {
    const configPath = process.env.CFL_REMOTE_CONFIG;
    if (!configPath)
      throw new LifecycleError(
        "remote_config_required",
        "Set CFL_REMOTE_CONFIG to the private controller client file.",
      );
    const config = await loadRemoteConfig(configPath);
    const artifactId = await uploadProject(config, root);
    console.log(JSON.stringify({ ok: true, artifactId, serializedBytes }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: failureOf(error) }));
  process.exitCode = 1;
}
