import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// Separate disposable application: native version previews cannot isolate scheduler namespaces.
const milestone = process.env.PROOF_MILESTONE ?? "m1";
if (milestone !== "m1" && milestone !== "m2")
  throw new Error("PROOF_MILESTONE must be m1 or m2");
const NAME = `mcpone-${milestone}-proof`;
const PRODUCTION_APP = "375fd22e-ecf2-4d33-b9cb-44b85f5153da";
const root = fileURLToPath(new URL("../", import.meta.url));
const stateDirectory = resolve(root, ".state");
const stateFile = resolve(stateDirectory, `${milestone}-hosted.json`);
const secretFile = resolve(stateDirectory, `${milestone}-hosted.secrets.json`);
const home = process.env.CFL_CLIENT_HOME;
const configPath = process.env.CFL_REMOTE_CONFIG;
if (!home || !configPath)
  throw new Error(
    "Set CFL_CLIENT_HOME and CFL_REMOTE_CONFIG to the existing private lifecycle client",
  );
const mutationFlag = `${milestone.toUpperCase()}_ALLOW_MUTATION`;
if (process.env[mutationFlag] !== "yes")
  throw new Error(
    `${mutationFlag}=yes is required for disposable hosted provisioning`,
  );
const moduleUrl = (name) => pathToFileURL(resolve(home, "dist/src", name)).href;
const { loadRemoteConfig, connectRemote } = await import(
  moduleUrl("remote.js")
);
const { snapshotProject } = await import(moduleUrl("project.js"));
const { canonical, sha256, MAX_HOSTED_ARTIFACT_BYTES, validateSnapshot } =
  await import(moduleUrl("artifact.js"));
const config = await loadRemoteConfig(configPath);
const client = await connectRemote(config);
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
let state;
try {
  state = JSON.parse(await readFile(stateFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  state = {};
}
if (
  state.applicationId === PRODUCTION_APP ||
  (state.name && state.name !== NAME)
)
  throw new Error("Refusing non-proof application state");
async function save() {
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  await chmod(stateFile, 0o600);
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const output =
    result.structuredContent ??
    JSON.parse(result.content.find((item) => item.type === "text").text);
  return output;
}
async function complete(submission) {
  if (!submission.operationId) {
    if (!submission.ok) throw new Error(JSON.stringify(submission.error));
    return submission;
  }
  state.operationId = submission.operationId;
  if (submission.application) {
    state.applicationId = submission.application.applicationId;
    state.workerName = submission.application.workerName;
    state.name = submission.application.name;
  }
  await save();
  let operation = submission;
  for (
    let attempt = 0;
    attempt < 180 && ["pending", "running"].includes(operation.status);
    attempt++
  ) {
    await delay(2000);
    operation = await call("get_operation", {
      operationId: submission.operationId,
    });
  }
  if (operation.status !== "ready")
    throw new Error(
      JSON.stringify({
        operationId: submission.operationId,
        status: operation.status,
        error: operation.error,
      }),
    );
  if (operation.application?.url) state.url = operation.application.url;
  state.lastReadyOperation = submission.operationId;
  await save();
  return operation;
}
async function upload(origin) {
  let secrets;
  try {
    const info = await stat(secretFile);
    if ((info.mode & 0o077) !== 0)
      throw new Error("Proof secret file must be mode 0600");
    secrets = JSON.parse(await readFile(secretFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    secrets = { BETTER_AUTH_SECRET: randomBytes(48).toString("base64url") };
    await writeFile(secretFile, JSON.stringify(secrets), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const snapshot = await snapshotProject(root);
  snapshot.config.vars = {
    NODE_ENV: "production",
    APP_SLUG: "mcpone",
    RELEASE: `${milestone}-proof`,
    BETTER_AUTH_URL: origin,
    TRUSTED_ORIGINS: origin,
  };
  snapshot.config.previewVars = { ...snapshot.config.vars };
  snapshot.config.secretsFile = `.state/${milestone}-hosted.secrets.json`;
  snapshot.config.previewSecretsFile = `.state/${milestone}-hosted.secrets.json`;
  delete snapshot.config.hostname;
  delete snapshot.config.previewHostname;
  const {
    config: artifactConfig,
    modules,
    assets,
    migrations,
    sourceCommit,
    sourceRef,
    sourceStatus,
  } = snapshot;
  snapshot.digest = sha256(
    canonical({
      config: artifactConfig,
      modules,
      assets,
      migrations,
      sourceCommit,
      sourceRef,
      sourceStatus: sourceStatus ?? "",
    }),
  );
  validateSnapshot(snapshot);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > MAX_HOSTED_ARTIFACT_BYTES)
    throw new Error("Proof artifact exceeds lifecycle limit");
  const response = await fetch(new URL("/artifacts", config.url), {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snapshot,
      productionSecrets: secrets,
      previewSecrets: secrets,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Proof artifact upload rejected (HTTP ${response.status})`);
  const output = await response.json();
  if (!output.ok || typeof output.artifactId !== "string")
    throw new Error("Invalid proof artifact response");
  state.artifactId = output.artifactId;
  state.artifactDigest = snapshot.digest;
  await save();
  return output.artifactId;
}

try {
  const command = process.argv[2] ?? "provision";
  if (command === "provision") {
    const apps = await call("list_apps", {});
    if (!apps.ok) throw new Error(JSON.stringify(apps.error));
    const existing = apps.applications.find(
      (app) => app.name === NAME && app.status !== "deleted",
    );
    if (existing)
      state = {
        ...state,
        applicationId: existing.applicationId,
        workerName: existing.workerName,
        name: NAME,
        url: existing.url,
      };
    else state = {};
    if (!state.applicationId) {
      const artifactId = await upload(`https://${milestone}-proof.invalid`);
      await complete(
        await call("create_app", {
          name: NAME,
          artifactId,
          requestId: `${milestone}-proof-create-${artifactId}`,
        }),
      );
    }
    let app = await call("get_app", { applicationId: state.applicationId });
    if (
      !app.ok ||
      app.application?.name !== NAME ||
      app.application.applicationId === PRODUCTION_APP ||
      !app.application.database?.databaseId ||
      app.application.database?.databaseId ===
        "95a44e24-b138-4960-bc5c-a5e8cc11e607"
    )
      throw new Error("Proof environment isolation/read-back failed");
    if (!app.application.url) {
      const databaseId = app.application.database.databaseId;
      if (app.application.status !== "failed")
        throw new Error(
          "Proof bootstrap is still pending; inspect its operation",
        );
      // A failed pre-publication migration can leave the owned empty proof
      // application provisioned. Publish the corrected artifact to that same
      // Worker/D1 identity; never create a replacement or alter its ledger.
      const artifactId = await upload(`https://${milestone}-proof.invalid`);
      await complete(
        await call("deploy", {
          applicationId: state.applicationId,
          artifactId,
          requestId: `${milestone}-proof-recover-${artifactId}`,
        }),
      );
      app = await call("get_app", { applicationId: state.applicationId });
      if (
        !app.ok ||
        app.application?.name !== NAME ||
        app.application.applicationId !== state.applicationId ||
        app.application.database?.databaseId !== databaseId ||
        !app.application.url
      )
        throw new Error("Corrected proof bootstrap did not publish a URL");
    }
    state.url = app.application.url;
    state.databaseId = app.application.database.databaseId;
    await save();
    const artifactId = await upload(state.url);
    await complete(
      await call("deploy", {
        applicationId: state.applicationId,
        artifactId,
        requestId: `${milestone}-proof-config-${artifactId}`,
      }),
    );
    const verified = await call("get_app", {
      applicationId: state.applicationId,
    });
    if (!verified.ok || !verified.cloudflare?.exists || !verified.health?.ok)
      throw new Error("Hosted proof live health failed");
    console.log(
      JSON.stringify({
        ok: true,
        name: NAME,
        applicationId: state.applicationId,
        workerName: state.workerName,
        databaseId: state.databaseId,
        url: state.url,
        operationId: state.lastReadyOperation,
        artifactDigest: state.artifactDigest,
      }),
    );
  } else if (command === "redeploy" || command === "migrate") {
    if (!state.applicationId || !state.url)
      throw new Error("Provision isolated proof environment first");
    const target = await call("get_app", {
      applicationId: state.applicationId,
    });
    if (
      !target.ok ||
      target.application?.name !== NAME ||
      target.application.applicationId === PRODUCTION_APP ||
      !target.application.url ||
      !target.application.database?.databaseId ||
      target.application.database.databaseId ===
        "95a44e24-b138-4960-bc5c-a5e8cc11e607"
    )
      throw new Error("Refusing redeploy: live proof target isolation failed");
    state.url = target.application.url;
    state.workerName = target.application.workerName;
    state.databaseId = target.application.database.databaseId;
    await save();
    let durableObjectMigration;
    if (command === "migrate") {
      const desired = JSON.parse(
        await readFile(resolve(root, "cloudflare-app.json"), "utf8"),
      ).durableObjects;
      const current = target.application.durableObjects;
      if (
        !Array.isArray(current) ||
        !Array.isArray(desired) ||
        desired.length !== 1 ||
        desired[0].name !== "CONTROL_SCHEDULER" ||
        desired[0].className !== "ControlScheduler" ||
        (current.length !== 0 &&
          (current.length !== 1 ||
            current[0].name !== desired[0].name ||
            current[0].className !== desired[0].className))
      )
        throw new Error(
          "Refusing migration: expected empty or matching proof layout",
        );
      durableObjectMigration = { expected: [], additions: desired };
    }
    const artifactId = await upload(state.url);
    await complete(
      await call("deploy", {
        applicationId: state.applicationId,
        artifactId,
        requestId: `${milestone}-proof-${command === "migrate" ? "migrate" : "restart"}-${artifactId}`,
        ...(durableObjectMigration ? { durableObjectMigration } : {}),
      }),
    );
    console.log(
      JSON.stringify({
        ok: true,
        operationId: state.lastReadyOperation,
        url: state.url,
      }),
    );
  } else if (command === "status") {
    if (!state.applicationId) throw new Error("Proof environment absent");
    console.log(
      JSON.stringify(
        await call("get_app", { applicationId: state.applicationId }),
      ),
    );
  } else if (command === "delete") {
    if (!state.applicationId) throw new Error("Proof environment absent");
    const app = await call("get_app", { applicationId: state.applicationId });
    if (app.application?.name !== NAME)
      throw new Error("Refusing to delete non-proof application");
    const deleted = await complete(
      await call("delete_app", {
        applicationId: state.applicationId,
        confirmName: NAME,
        requestId: `${milestone}-proof-delete-${state.applicationId}`,
      }),
    );
    await rm(secretFile, { force: true });
    state = {};
    await save();
    console.log(JSON.stringify(deleted));
  } else throw new Error("Use provision, migrate, redeploy, status or delete");
} catch (error) {
  // Never disclose response bodies from artifact upload or private config parsing.
  console.error(
    error instanceof Error ? error.message : "Hosted proof operation failed",
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
