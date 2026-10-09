import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import { ExecutionErrorCode } from "@scaffold/schema/execution";
import {
  BusinessMcpResult,
  type EffectEvidence,
  type HttpMethod,
  type JSONSchema,
  type JSONValue,
  jsonProblem,
} from "@scaffold/schema/integrations";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
  type VmCallResult,
} from "quickjs-emscripten-core";
import { parseStrictJson } from "../strict-json.js";
import { validateInput } from "./schema.js";
import {
  type CompiledTypeScriptArtifact,
  resolveTypeScriptModule,
  verifyCompiledTypeScriptArtifact,
} from "./typescript-artifact.js";

export const SANDBOX_LIMITS = Object.freeze({
  heapBytes: 8 * 1048576,
  stackBytes: 256 * 1024,
  wasmInitialPages: 256,
  wasmMaximumPages: 512,
  guestCpuMs: 100,
  wallMs: 60000,
  jsonBytes: 1048576,
  logBytes: 65536,
  jobs: 10000,
  interruptPolls: 1000,
});
export type QuickJSEngineFactory = () => Promise<QuickJSWASMModule>;
export interface SandboxBrokerRequest {
  accountRequirement: string | null;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: JSONValue;
  mediaType?: string;
}
export interface SandboxBrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: JSONValue;
}
export interface SandboxBroker {
  request(input: SandboxBrokerRequest): Promise<SandboxBrokerResponse>;
  effect(): EffectEvidence;
  redact(text: string): string;
}
export interface SandboxLog {
  level: "log" | "info" | "warn" | "error";
  text: string;
}
/** Bounded inert guest log values; native redactors never cross an RPC boundary. */
export interface SandboxLogValues {
  level: SandboxLog["level"];
  values: readonly JSONValue[];
}
function redactLogValue(
  value: JSONValue,
  redact: (text: string) => string,
): JSONValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((child) => redactLogValue(child, redact));
  if (value && typeof value === "object") {
    const object: Record<string, JSONValue> = Object.create(null) as Record<
      string,
      JSONValue
    >;
    for (const [key, child] of Object.entries(value))
      object[redact(key)] = redactLogValue(child, redact);
    return object;
  }
  return value;
}
/** Redact values and keys before JSON serialization, identically on all hosts. */
export function formatSandboxLog(
  input: SandboxLogValues,
  redact: (text: string) => string,
): SandboxLog {
  const text = input.values
    .map((value) => {
      const safe = redactLogValue(value, redact);
      return typeof safe === "string" ? safe : JSON.stringify(safe);
    })
    .join(" ");
  const entry: SandboxLog = { level: input.level, text };
  if (jsonProblem(entry, SANDBOX_LIMITS.logBytes))
    throw new Error("Invalid bounded sandbox log");
  return entry;
}
export type SandboxErrorCode =
  | "execution_failed"
  | "execution_timeout"
  | "sandbox_limit"
  | "unsupported_result"
  | "tool_unavailable";
export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    readonly effect: EffectEvidence,
  ) {
    super(
      {
        execution_failed:
          "The authored function failed in its isolated runtime",
        execution_timeout: "The authored function exceeded its Run deadline",
        sandbox_limit:
          "The authored function exceeded an isolation resource limit",
        unsupported_result: "The authored function did not return bounded JSON",
        tool_unavailable:
          "The pinned compiled Tool artifact is unavailable or incompatible",
      }[code],
    );
    this.name = "SandboxError";
  }
}
/** Only a real native broker rejection constructs this; guest errors cannot. */
export class SandboxBrokerError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    readonly effect: EffectEvidence,
    readonly retryable = false,
  ) {
    super("The trusted broker could not complete the reviewed request");
    this.name = "SandboxBrokerError";
  }
}

/**
 * Node: call with no options; the pinned sync variant loads its installed local WASM.
 * Worker: pass the statically imported ./quickjs.wasm WebAssembly.Module. No bytes,
 * downloads or request-time WebAssembly compilation are accepted by this helper.
 * The parent scheduler owns engine admission; this memoization adds no Run queue.
 */
export function createQuickJSEngineFactory(
  options: {
    wasmModule?: WebAssembly.Module;
    variant?: typeof releaseSync;
  } = {},
): QuickJSEngineFactory {
  let engine: Promise<QuickJSWASMModule> | undefined;
  return () => {
    if (!engine) {
      const memory = new WebAssembly.Memory({
        initial: SANDBOX_LIMITS.wasmInitialPages,
        maximum: SANDBOX_LIMITS.wasmMaximumPages,
      });
      const variant = newVariant(options.variant ?? releaseSync, {
        wasmMemory: memory,
        ...(options.wasmModule ? { wasmModule: options.wasmModule } : {}),
      });
      engine = newQuickJSWASMModuleFromVariant(variant).then((module) => {
        if (
          module.getWasmMemory() !== memory ||
          memory.buffer.byteLength > SANDBOX_LIMITS.wasmMaximumPages * 65536
        )
          throw new Error(
            "The static QuickJS loader did not honor the bounded memory hook",
          );
        return module;
      });
    }
    return engine;
  };
}

// All intrinsics are captured before any dependency executes. Only this guest
// closure retains the temporary native bridge; neither its host object nor any
// generic native reflection/loading/credential capability enters the guest.
const BOOTSTRAP = `(() => {
  const bridge = globalThis.__mcpone_bridge, logBridge = globalThis.__mcpone_log;
  delete globalThis.__mcpone_bridge;
  delete globalThis.__mcpone_log;
  const apply = Reflect.apply, keys = Object.keys, symbols = Object.getOwnPropertySymbols;
  const descriptor = Object.getOwnPropertyDescriptor, proto = Object.getPrototypeOf;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const internalErrorPrototype = globalThis.InternalError.prototype;
  const isArray = Array.isArray, finite = Number.isFinite, stringify = JSON.stringify, parse = JSON.parse;
  const join = Array.prototype.join, hasOwn = Object.prototype.hasOwnProperty;
  const charCode = String.prototype.charCodeAt, freeze = Object.freeze, PromiseCtor = Promise, string = String;
  function bytes(text,limit=1048576) {
    let n=0;
    for(let i=0;i<text.length;i++) { const c=apply(charCode,text,[i]);
      if(c>=0xd800&&c<=0xdbff) { const d=apply(charCode,text,[++i]); if(!(d>=0xdc00&&d<=0xdfff)) throw 0; n+=4; }
      else if(c>=0xdc00&&c<=0xdfff) throw 0;
      else n+=c<128?1:c<2048?2:3;
      if(n>limit) throw 0;
    }
    return n;
  }
  function serialize(value,limit=1048576) {
    let size=0,nodes=0; const chunks=[],ancestors=[];
    function emit(text) { size+=bytes(text,limit);if(size>limit)throw 0;chunks[chunks.length]=text; }
    function walk(v,depth) {
      if(++nodes>100000||depth>64)throw 0;
      if(v===null) {emit('null');return;}
      switch(typeof v) {
        case 'boolean':emit(v?'true':'false');return;
        case 'number':if(!finite(v))throw 0;emit(stringify(v));return;
        case 'string':bytes(v,limit);emit(stringify(v));return;
        case 'object':break;
        default:throw 0;
      }
      for(let i=0;i<ancestors.length;i++)if(ancestors[i]===v)throw 0;
      const array=isArray(v),p=proto(v);if((array&&p!==arrayPrototype)||(!array&&p!==objectPrototype&&p!==null)||symbols(v).length)throw 0;
      ancestors[ancestors.length]=v;
      const names=keys(v);
      if(names.length>100000)throw 0;
      if(array) {
        if(names.length!==v.length)throw 0;emit('[');
        for(let i=0;i<v.length;i++) { if(names[i]!==string(i))throw 0;if(i)emit(',');const d=descriptor(v,names[i]);if(!d||!apply(hasOwn,d,['value']))throw 0;walk(d.value,depth+1); }
        emit(']');
      } else {
        emit('{');
        for(let i=0;i<names.length;i++) { const name=names[i],d=descriptor(v,name);if(!d||!apply(hasOwn,d,['value']))throw 0;if(i)emit(',');bytes(name,limit);emit(stringify(name));emit(':');walk(d.value,depth+1); }
        emit('}');
      }
      ancestors.length--;
    }
    walk(value,0);return apply(join,chunks,['']);
  }
  globalThis.console=freeze({
    log(...values){logBridge('log',serialize(values,65536));},
    info(...values){logBridge('info',serialize(values,65536));},
    warn(...values){logBridge('warn',serialize(values,65536));},
    error(...values){logBridge('error',serialize(values,65536));}
  });
  const http=freeze({request(request) {
    let text;
    try {text=serialize(request);} catch {return PromiseCtor.reject(new Error('Invalid bounded broker request'));}
    return bridge(text).then((response)=>parse(response));
  }});
  const ctx=freeze({http});
  function resourceFailure(value) {
    try {
      if(value===null || typeof value!=='object' || proto(value)!==internalErrorPrototype)return 0;
      return descriptor(value,'message')?.value==='out of memory' ? 1 : 0;
    } catch {return 0;}
  }
  return freeze({parse,serialize,resourceFailure,invoke(fn,input) {return fn(parse(input),ctx);}});
})()`;

const encoder = new TextEncoder();
function safeJson(value: unknown): string {
  if (jsonProblem(value, SANDBOX_LIMITS.jsonBytes))
    throw new Error("Invalid bounded JSON");
  return JSON.stringify(value);
}
function parseJson(text: string): JSONValue {
  if (
    text.length > SANDBOX_LIMITS.jsonBytes ||
    encoder.encode(text).length > SANDBOX_LIMITS.jsonBytes
  )
    throw new Error("Invalid bounded JSON");
  const value = parseStrictJson(text);
  if (jsonProblem(value, SANDBOX_LIMITS.jsonBytes))
    throw new Error("Invalid bounded JSON");
  return value as JSONValue;
}
function brokerInput(value: JSONValue): SandboxBrokerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid broker request");
  const allowed: Record<string, true> = {
    accountRequirement: true,
    method: true,
    url: true,
    headers: true,
    body: true,
    mediaType: true,
  };
  if (
    Object.keys(value).some((key) => !Object.hasOwn(allowed, key)) ||
    !(
      value.accountRequirement === null ||
      typeof value.accountRequirement === "string"
    ) ||
    typeof value.url !== "string" ||
    typeof value.method !== "string" ||
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(value.method) ||
    (value.mediaType !== undefined && typeof value.mediaType !== "string")
  )
    throw new Error("Invalid broker request");
  if (
    value.headers !== undefined &&
    (!value.headers ||
      typeof value.headers !== "object" ||
      Array.isArray(value.headers) ||
      Object.values(value.headers).some((header) => typeof header !== "string"))
  )
    throw new Error("Invalid broker headers");
  return value as unknown as SandboxBrokerRequest;
}

async function waitForDeadline<T>(
  work: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  timeoutError: () => Error,
): Promise<T> {
  if (signal?.aborted || Date.now() >= deadline) throw timeoutError();
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = globalThis.setTimeout(
    () => reject(timeoutError()),
    Math.max(0, deadline - Date.now()),
  );
  const abort = signal ? () => reject(timeoutError()) : undefined;
  if (abort) signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export interface SandboxInvocation {
  artifact: CompiledTypeScriptArtifact;
  artifactDigest: string;
  arguments: Record<string, JSONValue>;
  outputSchema?: JSONSchema;
  deadlineMs: number;
  broker: SandboxBroker;
  signal?: AbortSignal;
  onLogs?: (entries: readonly SandboxLog[]) => Promise<void>;
  /** Private native bridge: returns actual parent-redacted serialized log bytes. */
  onLogValues?: (entries: readonly SandboxLogValues[]) => Promise<number>;
}
export interface SandboxResult {
  result: BusinessMcpResult;
  effect: EffectEvidence;
}
export interface TypeScriptSandbox {
  invoke(input: SandboxInvocation): Promise<SandboxResult>;
}
export function createTypeScriptSandbox(options: {
  engineFactory: QuickJSEngineFactory;
  now?: () => number;
}): TypeScriptSandbox {
  // Deployed Workers freeze performance/Date clocks until I/O; local Wrangler
  // does not. Interrupt/job ceilings are independent finite-work bounds, not a
  // milliseconds conversion or proof of the hosted 100 ms CPU target.
  const now = options.now ?? (() => performance.now());
  return {
    async invoke(input) {
      const effect = (): EffectEvidence => input.broker.effect();
      const failure = (code: SandboxErrorCode) =>
        new SandboxError(code, effect());
      const deadline = Math.min(
        input.deadlineMs,
        Date.now() + SANDBOX_LIMITS.wallMs,
      );
      if (
        !Number.isFinite(deadline) ||
        Date.now() >= deadline ||
        input.signal?.aborted
      )
        throw failure("execution_timeout");
      let artifact: CompiledTypeScriptArtifact, argumentsText: string;
      try {
        artifact = parseStrictJson(
          safeJson(input.artifact),
        ) as CompiledTypeScriptArtifact;
      } catch {
        throw failure("tool_unavailable");
      }
      try {
        argumentsText = safeJson(input.arguments);
      } catch {
        throw failure("unsupported_result");
      }
      if (
        !(await waitForDeadline(
          verifyCompiledTypeScriptArtifact(artifact, input.artifactDigest),
          deadline,
          input.signal,
          () => failure("execution_timeout"),
        ))
      )
        throw failure("tool_unavailable");
      // Retained artifacts are checked, never regenerated from source at Run time.
      const modules = Object.freeze(artifact.modules);
      const entryModule = artifact.entryModule,
        entrypoint = artifact.entrypoint;
      let module: QuickJSWASMModule;
      try {
        module = await waitForDeadline(
          options.engineFactory(),
          deadline,
          input.signal,
          () => failure("execution_timeout"),
        );
      } catch (error) {
        if (error instanceof SandboxError) throw error;
        throw failure("tool_unavailable");
      }
      if (Date.now() >= deadline || input.signal?.aborted)
        throw failure("execution_timeout");
      const runtime = module.newRuntime();
      let context: QuickJSContext | undefined,
        alive = true,
        cpu = 0,
        activeStart: number | undefined,
        polls = 0,
        jobs = 0;
      let stopped: "execution_timeout" | "sandbox_limit" | undefined;
      let pending:
        | { deferred: QuickJSDeferredPromise; request: SandboxBrokerRequest }
        | undefined;
      const logs: SandboxLog[] = [];
      const rawLogs: SandboxLogValues[] = [];
      let logBytes = 0,
        rawLogBytes = 2;
      async function flushLogs() {
        if (rawLogs.length && input.onLogValues) {
          const batch = rawLogs.splice(0);
          rawLogBytes = 2;
          const bytes = await waitForDeadline(
            input.onLogValues(batch),
            deadline,
            input.signal,
            () => failure("execution_timeout"),
          );
          if (!Number.isSafeInteger(bytes) || bytes < 0)
            throw failure("sandbox_limit");
          logBytes += bytes;
          if (logBytes > SANDBOX_LIMITS.logBytes)
            throw failure("sandbox_limit");
        }
        const batch = logs.splice(0);
        if (batch.length && input.onLogs)
          await waitForDeadline(
            input.onLogs(batch),
            deadline,
            input.signal,
            () => failure("execution_timeout"),
          );
      }
      const handles: QuickJSHandle[] = [],
        deferreds: QuickJSDeferredPromise[] = [];
      let resourceFailure: QuickJSHandle | undefined;
      function check() {
        if (stopped) throw failure(stopped);
        if (input.signal?.aborted || Date.now() >= deadline) {
          stopped = "execution_timeout";
          throw failure(stopped);
        }
        if (
          cpu +
            (activeStart === undefined
              ? 0
              : Math.max(0, now() - activeStart)) >=
            SANDBOX_LIMITS.guestCpuMs ||
          polls >= SANDBOX_LIMITS.interruptPolls ||
          jobs >= SANDBOX_LIMITS.jobs
        ) {
          stopped = "sandbox_limit";
          throw failure(stopped);
        }
      }
      function guest<T>(operation: () => T): T {
        const outer = activeStart === undefined;
        if (outer) {
          check();
          activeStart = now();
        }
        try {
          return operation();
        } finally {
          if (outer) {
            cpu += Math.max(0, now() - activeStart!);
            activeStart = undefined;
          }
        }
      }
      runtime.setInterruptHandler(() => {
        polls++;
        try {
          check();
          return false;
        } catch {
          return true;
        }
      });
      function keep(handle: QuickJSHandle) {
        handles.push(handle);
        return handle;
      }
      function rejectGuest(
        error: QuickJSHandle,
        code: SandboxErrorCode,
      ): never {
        try {
          if (!stopped && resourceFailure) {
            // Inspect inside the bounded guest; never copy arbitrary thrown
            // objects/messages to the host. This only chooses a permanent
            // denial and cannot create broker retry/effect evidence.
            const result = guest(() =>
              context!.callFunction(
                resourceFailure!,
                context!.undefined,
                error,
              ),
            );
            if (result.error) result.error.dispose();
            else {
              try {
                if (context!.getNumber(result.value) === 1)
                  code = "sandbox_limit";
              } finally {
                result.value.dispose();
              }
            }
          }
          throw failure(stopped ?? code);
        } finally {
          error.dispose();
        }
      }
      function unwrap(
        result: VmCallResult<QuickJSHandle>,
        code: SandboxErrorCode,
      ): QuickJSHandle {
        if (result.error) rejectGuest(result.error, code);
        return keep(result.value);
      }
      async function beforeDeadline<T>(work: Promise<T>): Promise<T> {
        check();
        return waitForDeadline(work, deadline, input.signal, () =>
          failure("execution_timeout"),
        );
      }
      async function settle(handle: QuickJSHandle): Promise<QuickJSHandle> {
        for (;;) {
          await flushLogs();
          check();
          if (runtime.hasPendingJob()) {
            const result = guest(() => runtime.executePendingJobs(1));
            jobs++;
            if (result.error) rejectGuest(result.error, "execution_failed");
            continue;
          }
          const state = guest(() => context!.getPromiseState(handle));
          if (state.type === "fulfilled") {
            if (pending) {
              state.value.dispose();
              throw failure("execution_failed");
            }
            return keep(state.value);
          }
          if (state.type === "rejected")
            rejectGuest(state.error, "execution_failed");
          if (pending) {
            const request = pending;
            const work = Promise.resolve().then(() => {
              check();
              return input.broker.request(request.request);
            });
            let response: SandboxBrokerResponse;
            try {
              response = await beforeDeadline(work);
            } catch (error) {
              if (error instanceof SandboxError) throw error;
              const parsed = ExecutionErrorCode.safeParse(
                error instanceof Error && "code" in error
                  ? error.code
                  : undefined,
              );
              // Abort before resolving/rejecting a guest promise: a frozen
              // authority denial must never be caught or rewritten by guest code.
              const retryable =
                parsed.success &&
                error instanceof Error &&
                "retryable" in error &&
                error.retryable === true;
              throw new SandboxBrokerError(
                parsed.success ? parsed.data : "execution_failed",
                effect(),
                retryable,
              );
            }
            if (!alive) throw failure("execution_timeout");
            pending = undefined;
            guest(() => {
              let text: string;
              try {
                text = safeJson(response);
              } catch {
                throw failure("unsupported_result");
              }
              const value = context!.newString(text);
              try {
                request.deferred.resolve(value);
              } finally {
                value.dispose();
              }
            });
            continue;
          }
          // An unresolved guest promise without jobs or a broker cannot make
          // progress; do not park an engine for the remainder of the Run wall time.
          throw failure("execution_failed");
        }
      }
      try {
        runtime.setMemoryLimit(SANDBOX_LIMITS.heapBytes);
        runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
        context = runtime.newContext();
        runtime.setModuleLoader(
          (name) => {
            if (!Object.hasOwn(modules, name))
              return {
                error: new Error("Module is outside the pinned source closure"),
              };
            return modules[name]!;
          },
          (base, name) => {
            try {
              const id = resolveTypeScriptModule(base, name);
              return Object.hasOwn(modules, id)
                ? id
                : {
                    error: new Error(
                      "Module is outside the pinned source closure",
                    ),
                  };
            } catch {
              return {
                error: new Error("Module is outside the pinned source closure"),
              };
            }
          },
        );
        const bridge = keep(
          context.newFunction("request", (serialized) => {
            if (
              !alive ||
              !serialized ||
              context!.typeof(serialized) !== "string"
            )
              return { error: context!.newError("Invalid broker request") };
            if (pending)
              return {
                error: context!.newError(
                  "Only one broker request may be outstanding",
                ),
              };
            let request: SandboxBrokerRequest;
            try {
              check();
              request = brokerInput(parseJson(context!.getString(serialized)));
            } catch {
              return { error: context!.newError("Invalid broker request") };
            }
            const deferred = context!.newPromise();
            deferreds.push(deferred);
            pending = { deferred, request };
            return deferred.handle.dup();
          }),
        );
        context.setProp(context.global, "__mcpone_bridge", bridge);
        const logBridge = keep(
          context.newFunction("log", (level, serialized) => {
            try {
              check();
              if (
                !alive ||
                !level ||
                !serialized ||
                context!.typeof(level) !== "string" ||
                context!.typeof(serialized) !== "string"
              )
                throw failure("sandbox_limit");
              const kind = context!.getString(level);
              if (!["log", "info", "warn", "error"].includes(kind))
                throw failure("sandbox_limit");
              const text = context!.getString(serialized);
              const serializedBytes = encoder.encode(text).length;
              if (serializedBytes > SANDBOX_LIMITS.logBytes)
                throw failure("sandbox_limit");
              const values = parseJson(text);
              if (!Array.isArray(values)) throw failure("sandbox_limit");
              const rawEntry: SandboxLogValues = {
                level: kind as SandboxLog["level"],
                values,
              };
              if (input.onLogValues) {
                // The sync VM cannot await RPC inside console.log. Bound its
                // private raw carrier independently from redacted log output.
                // Header/brackets/commas plus the canonical serialized values
                // are exactly the bytes sent in the pending RPC array.
                rawLogBytes +=
                  22 + kind.length + serializedBytes + (rawLogs.length ? 1 : 0);
                if (rawLogBytes > SANDBOX_LIMITS.jsonBytes)
                  throw failure("sandbox_limit");
                rawLogs.push(rawEntry);
              } else {
                const entry = formatSandboxLog(rawEntry, (text) =>
                  input.broker.redact(text),
                );
                logBytes += encoder.encode(JSON.stringify(entry)).length;
                if (logBytes > SANDBOX_LIMITS.logBytes)
                  throw failure("sandbox_limit");
                logs.push(entry);
              }
              return context!.undefined;
            } catch {
              stopped = "sandbox_limit";
              return {
                error: context!.newError(
                  "Guest logging exceeded its bounded safe-data limit",
                ),
              };
            }
          }),
        );
        context.setProp(context.global, "__mcpone_log", logBridge);
        const helpers = unwrap(
          guest(() =>
            context!.evalCode(BOOTSTRAP, "/trusted-bootstrap.js", {
              type: "global",
              strict: true,
            }),
          ),
          "sandbox_limit",
        );
        const invoke = keep(context.getProp(helpers, "invoke")),
          serialize = keep(context.getProp(helpers, "serialize"));
        resourceFailure = keep(context.getProp(helpers, "resourceFailure"));
        const exports = await settle(
          unwrap(
            guest(() =>
              context!.evalCode(modules[entryModule]!, entryModule, {
                type: "module",
                strict: true,
              }),
            ),
            "sandbox_limit",
          ),
        );
        const fn = keep(guest(() => context!.getProp(exports, entrypoint)));
        if (context.typeof(fn) !== "function")
          throw failure("tool_unavailable");
        const argument = keep(context.newString(argumentsText));
        const value = await settle(
          unwrap(
            guest(() =>
              context!.callFunction(invoke, context!.undefined, fn, argument),
            ),
            "execution_failed",
          ),
        );
        const serialized = unwrap(
          guest(() =>
            context!.callFunction(serialize, context!.undefined, value),
          ),
          "unsupported_result",
        );
        await flushLogs();
        if (context.typeof(serialized) !== "string")
          throw failure("unsupported_result");
        let output: JSONValue;
        try {
          output = parseJson(context.getString(serialized));
        } catch {
          throw failure("unsupported_result");
        }
        if (
          input.outputSchema !== undefined &&
          !validateInput(input.outputSchema, output, { direction: "response" })
            .valid
        )
          throw failure("unsupported_result");
        const text = JSON.stringify(output);
        const result: BusinessMcpResult =
          output !== null &&
          typeof output === "object" &&
          !Array.isArray(output)
            ? { content: [{ type: "text", text }], structuredContent: output }
            : { content: [{ type: "text", text }] };
        if (!BusinessMcpResult.safeParse(result).success)
          throw failure("unsupported_result");
        check();
        return { result, effect: effect() };
      } catch (error) {
        await flushLogs();
        if (
          error instanceof SandboxError ||
          error instanceof SandboxBrokerError
        )
          throw error;
        throw failure(stopped ?? "sandbox_limit");
      } finally {
        alive = false;
        for (let index = handles.length - 1; index >= 0; index--)
          if (handles[index]!.alive) handles[index]!.dispose();
        for (const deferred of deferreds) deferred.dispose();
        if (context?.alive) context.dispose();
        if (runtime.alive) runtime.dispose();
      }
    },
  };
}
