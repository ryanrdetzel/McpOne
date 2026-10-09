import type { Implementation } from "@scaffold/schema/integrations";
import { isJsonObject, jsonProblem } from "@scaffold/schema/integrations";
import * as ts from "typescript";
import { canonicalJson, sha256 } from "../execution/canonical.js";

import {
  type CompiledTypeScriptArtifact,
  ENTRY_MODULE,
  moduleId,
  QUICKJS_RUNTIME_VERSION,
  resolveTypeScriptModule,
  TYPESCRIPT_COMPILER_VERSION,
  TYPESCRIPT_LIMITS,
} from "./typescript-artifact.js";
export type TypeScriptImplementation = Extract<
  Implementation,
  { kind: "typescript" }
>;
export interface TypeScriptDiagnostic {
  code: string;
  module: string;
  line: number;
  column: number;
  message: string;
}
export type TypeScriptCompilation =
  | {
      valid: true;
      artifact: CompiledTypeScriptArtifact;
      diagnostics: TypeScriptDiagnostic[];
    }
  | { valid: false; diagnostics: TypeScriptDiagnostic[] };

// Deliberately no DOM/Node/environment declarations or filesystem-backed compiler host.
// These declarations describe the portable guest built-ins, not capabilities in the host.
const GUEST_LIB = `
interface Object { constructor: Function; toString(): string; hasOwnProperty(key: PropertyKey): boolean }
interface ObjectConstructor { new(value?: any): Object; (value?: any): any; keys(value: object): string[]; values<T>(value: {[key:string]:T}): T[]; entries<T>(value: {[key:string]:T}): [string,T][]; assign<T extends object>(target:T,...sources:any[]):T; create(proto:object|null):any; freeze<T>(value:T):Readonly<T>; getPrototypeOf(value:any):any; getOwnPropertyDescriptor(value:any,key:PropertyKey):PropertyDescriptor|undefined; defineProperty(value:any,key:PropertyKey,descriptor:PropertyDescriptor):any }
declare var Object: ObjectConstructor;
interface PropertyDescriptor { value?:any; writable?:boolean; get?:()=>any; set?:(value:any)=>void; enumerable?:boolean; configurable?:boolean }
interface Function { apply(thisArg:any,args?:any):any; call(thisArg:any,...args:any[]):any; bind(thisArg:any,...args:any[]):any; readonly name:string; readonly length:number }
interface CallableFunction extends Function {} interface NewableFunction extends Function {}
interface FunctionConstructor { new(...args:string[]):Function; (...args:string[]):Function; readonly prototype:Function }
declare var Function:FunctionConstructor;
interface IArguments { [index:number]:any; length:number; callee:Function }
interface String { readonly length:number; [index:number]:string; charAt(index:number):string; charCodeAt(index:number):number; codePointAt(index:number):number|undefined; slice(start?:number,end?:number):string; substring(start:number,end?:number):string; split(separator:string|RegExp,limit?:number):string[]; trim():string; toLowerCase():string; toUpperCase():string; includes(value:string,position?:number):boolean; startsWith(value:string,position?:number):boolean; endsWith(value:string,position?:number):boolean; replace(search:string|RegExp,replacement:string|((...args:any[])=>string)):string; replaceAll(search:string|RegExp,replacement:string):string; repeat(count:number):string; indexOf(search:string,position?:number):number; match(regexp:RegExp):RegExpMatchArray|null; padStart(length:number,fill?:string):string; padEnd(length:number,fill?:string):string }
interface StringConstructor { (value?:any):string; new(value?:any):String; fromCharCode(...codes:number[]):string; fromCodePoint(...codes:number[]):string }
declare var String:StringConstructor;
interface Number { toString(radix?:number):string; toFixed(digits?:number):string }
interface NumberConstructor { (value?:any):number; new(value?:any):Number; isFinite(value:unknown):boolean; isInteger(value:unknown):boolean; isNaN(value:unknown):boolean; parseInt(value:string,radix?:number):number; parseFloat(value:string):number; readonly MAX_SAFE_INTEGER:number; readonly MIN_SAFE_INTEGER:number }
declare var Number:NumberConstructor;
interface Boolean { valueOf():boolean } declare var Boolean:{(value?:any):boolean;new(value?:any):Boolean};
interface RegExp { test(value:string):boolean; exec(value:string):RegExpExecArray|null; source:string; flags:string; lastIndex:number }
declare var RegExp:{new(pattern:string|RegExp,flags?:string):RegExp;(pattern:string|RegExp,flags?:string):RegExp};
interface RegExpMatchArray extends Array<string> { index?:number; input?:string } interface RegExpExecArray extends Array<string> { index:number; input:string }
interface Symbol {} type PropertyKey=string|number|symbol; declare var Symbol:{(description?:string|number):symbol;for(key:string):symbol;readonly iterator:unique symbol};
interface IteratorResult<T> { value:T; done?:boolean } interface Iterator<T> { next(...args:any[]):IteratorResult<T> } interface Iterable<T> { [Symbol.iterator]():Iterator<T> }
interface Array<T> { [index:number]:T; length:number; [Symbol.iterator]():Iterator<T>; map<U>(fn:(value:T,index:number,array:T[])=>U):U[]; filter(fn:(value:T,index:number,array:T[])=>unknown):T[]; reduce<U>(fn:(acc:U,value:T,index:number,array:T[])=>U,initial:U):U; reduce(fn:(acc:T,value:T,index:number,array:T[])=>T):T; forEach(fn:(value:T,index:number,array:T[])=>void):void; find(fn:(value:T,index:number,array:T[])=>unknown):T|undefined; some(fn:(value:T,index:number,array:T[])=>unknown):boolean; every(fn:(value:T,index:number,array:T[])=>unknown):boolean; push(...values:T[]):number; pop():T|undefined; shift():T|undefined; unshift(...values:T[]):number; slice(start?:number,end?:number):T[]; splice(start:number,count?:number,...values:T[]):T[]; join(separator?:string):string; includes(value:T,from?:number):boolean; indexOf(value:T,from?:number):number; concat(...values:(T|T[])[]):T[]; sort(compare?:(a:T,b:T)=>number):this; reverse():T[]; fill(value:T,start?:number,end?:number):this }
interface ReadonlyArray<T> { readonly [index:number]:T; readonly length:number; [Symbol.iterator]():Iterator<T>; map<U>(fn:(value:T,index:number,array:readonly T[])=>U):U[]; join(separator?:string):string; slice(start?:number,end?:number):T[] }
declare var Array:{new<T>(length?:number):T[];new<T>(...items:T[]):T[];isArray(value:any):value is any[];from<T>(values:Iterable<T>|ArrayLike<T>):T[];from<T,U>(values:Iterable<T>|ArrayLike<T>,map:(value:T,index:number)=>U):U[]}; interface ArrayLike<T> { readonly length:number;readonly [index:number]:T }
interface PromiseLike<T> { then<U=T,V=never>(onfulfilled?:((value:T)=>U|PromiseLike<U>)|null,onrejected?:((reason:any)=>V|PromiseLike<V>)|null):PromiseLike<U|V> }
interface Promise<T> { then<U=T,V=never>(onfulfilled?:((value:T)=>U|PromiseLike<U>)|null,onrejected?:((reason:any)=>V|PromiseLike<V>)|null):Promise<U|V>; catch<U=never>(onrejected?:((reason:any)=>U|PromiseLike<U>)|null):Promise<T|U>; finally(fn?:()=>void):Promise<T> }
declare var Promise:{new<T>(executor:(resolve:(value:T|PromiseLike<T>)=>void,reject:(reason?:any)=>void)=>void):Promise<T>;resolve<T>(value:T|PromiseLike<T>):Promise<Awaited<T>>;resolve():Promise<void>;reject<T=never>(reason?:any):Promise<T>;all<T>(values:Iterable<T|PromiseLike<T>>):Promise<Awaited<T>[]>;race<T>(values:Iterable<T|PromiseLike<T>>):Promise<Awaited<T>>};
type Awaited<T>=T extends null|undefined?T:T extends PromiseLike<infer U>?Awaited<U>:T;
interface Error { name:string;message:string;stack?:string } declare var Error:{new(message?:string):Error;(message?:string):Error}; declare var TypeError:typeof Error; declare var RangeError:typeof Error; declare var SyntaxError:typeof Error;
declare var JSON:{parse(value:string):any;stringify(value:any,replacer?:any,space?:string|number):string|undefined};
declare var Math:{abs(value:number):number;floor(value:number):number;ceil(value:number):number;round(value:number):number;trunc(value:number):number;min(...values:number[]):number;max(...values:number[]):number;pow(base:number,exponent:number):number;sqrt(value:number):number;random():number;readonly PI:number};
declare function parseInt(value:string,radix?:number):number; declare function parseFloat(value:string):number; declare function isFinite(value:number):boolean; declare function isNaN(value:number):boolean; declare function encodeURIComponent(value:string):string; declare function decodeURIComponent(value:string):string;
declare const NaN:number; declare const Infinity:number;
interface Date { toISOString():string; getTime():number; valueOf():number; getUTCFullYear():number; getUTCMonth():number; getUTCDate():number }
declare var Date:{new(value?:string|number):Date;now():number;parse(value:string):number;UTC(year:number,month:number,...parts:number[]):number};
interface Map<K,V> { readonly size:number;get(key:K):V|undefined;set(key:K,value:V):this;has(key:K):boolean;delete(key:K):boolean;clear():void;keys():Iterable<K>;values():Iterable<V>;entries():Iterable<[K,V]>;[Symbol.iterator]():Iterator<[K,V]> }
declare var Map:{new<K,V>(entries?:Iterable<readonly [K,V]>):Map<K,V>};
interface Set<T> { readonly size:number;add(value:T):this;has(value:T):boolean;delete(value:T):boolean;clear():void;values():Iterable<T>;[Symbol.iterator]():Iterator<T> }
declare var Set:{new<T>(values?:Iterable<T>):Set<T>};
type Record<K extends keyof any,T>={[P in K]:T}; type Partial<T>={[P in keyof T]?:T[P]}; type Readonly<T>={readonly [P in keyof T]:T[P]}; type Pick<T,K extends keyof T>={[P in K]:T[P]}; type Exclude<T,U>=T extends U?never:T; type Omit<T,K extends keyof any>=Pick<T,Exclude<keyof T,K>>;
interface GuestHttpRequest { accountRequirement:string|null;method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD';url:string;headers?:Record<string,string>;body?:any;mediaType?:string }
interface GuestContext { readonly http:{request(input:GuestHttpRequest):Promise<{status:number;headers:Record<string,string>;body:any}>} }
declare const console:{log(...values:unknown[]):void;info(...values:unknown[]):void;warn(...values:unknown[]):void;error(...values:unknown[]):void};
`;

const encoder = new TextEncoder();
const own = (value: object, key: string) => Object.hasOwn(value, key);
function diagnostic(
  file: ts.SourceFile | undefined,
  node: ts.Node | undefined,
  code: string,
  message: string,
): TypeScriptDiagnostic {
  const position =
    file && node
      ? file.getLineAndCharacterOfPosition(node.getStart(file))
      : { line: 0, character: 0 };
  return {
    code,
    module: file?.fileName ?? ENTRY_MODULE,
    line: position.line + 1,
    column: position.character + 1,
    message,
  };
}
function pure(node: ts.Expression): boolean {
  if (
    ts.isLiteralExpression(node) ||
    ts.isIdentifier(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  )
    return true;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return pure(node.expression);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every(
      (element) =>
        !ts.isSpreadElement(element) &&
        (ts.isOmittedExpression(element) || pure(element)),
    );
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every((property) => {
      if (property.name && ts.isComputedPropertyName(property.name))
        return false;
      return ts.isPropertyAssignment(property)
        ? pure(property.initializer)
        : ts.isShorthandPropertyAssignment(property)
          ? !property.objectAssignmentInitializer
          : ts.isMethodDeclaration(property) ||
            ts.isGetAccessorDeclaration(property) ||
            ts.isSetAccessorDeclaration(property);
    });
  // Property access can execute an imported getter, and coercion can execute user code.
  // Conservative pure initializers intentionally exclude both.
  return false;
}
function inspectSource(
  file: ts.SourceFile,
  sources: Readonly<Record<string, string>>,
  diagnostics: TypeScriptDiagnostic[],
) {
  const reject = (node: ts.Node, message: string) => {
    if (diagnostics.length < 100)
      diagnostics.push(diagnostic(file, node, "unsupported_feature", message));
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause)
        reject(statement, "Side-effect-only imports are unsupported");
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (declaration.initializer && !pure(declaration.initializer))
          reject(
            declaration,
            "Module initializers must be inert declarations; move computation into the exported function",
          );
    } else if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals || !pure(statement.expression))
        reject(
          statement,
          "The entry export must be an inert ES module declaration",
        );
    } else if (ts.isClassDeclaration(statement)) {
      if (statement.heritageClauses?.length)
        reject(
          statement,
          "Top-level class inheritance is unsupported because it can execute module initialization",
        );
      for (const member of statement.members) {
        if (
          ts.isClassStaticBlockDeclaration(member) ||
          (member.name && ts.isComputedPropertyName(member.name)) ||
          (ts.canHaveModifiers(member) &&
            ts
              .getModifiers(member)
              ?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
            ts.isPropertyDeclaration(member) &&
            member.initializer)
        )
          reject(member, "Executable class initialization is unsupported");
      }
    } else if (
      !ts.isFunctionDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isExportDeclaration(statement) &&
      !ts.isEmptyStatement(statement)
    )
      reject(statement, "Executable module initialization is unsupported");
  }
  let nodes = 0;
  function visit(node: ts.Node, depth: number) {
    if (++nodes > 100000 || depth > 256) {
      reject(
        node,
        "The source syntax tree exceeds the trusted compiler structural budget",
      );
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier) {
        if (!ts.isStringLiteral(specifier))
          reject(node, "Module specifiers must be literal relative .ts paths");
        else
          try {
            const id = resolveTypeScriptModule(file.fileName, specifier.text);
            if (!own(sources, id))
              reject(
                node,
                "Imported module is missing from the immutable closure",
              );
          } catch {
            reject(
              node,
              "Module import escapes or requires an unsupported runtime package",
            );
          }
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isDecorator(node) ||
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node) ||
      (ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword)
    )
      reject(node, "This syntax requires an unsupported runtime capability");
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          ["require", "eval"].includes(node.expression.text)))
    )
      reject(
        node,
        "Dynamic imports, package loaders and source evaluation are unsupported",
      );
    if (
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
    )
      reject(
        node,
        "Authored ambient declarations cannot introduce host capabilities",
      );
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  }
  visit(file, 0);
}

/** No execution, network, package installation or filesystem reads occur in validation. */
export async function compileTypeScript(
  implementation: TypeScriptImplementation,
): Promise<TypeScriptCompilation> {
  const diagnostics: TypeScriptDiagnostic[] = [];
  const reject = (message: string) => ({
    valid: false as const,
    diagnostics: [diagnostic(undefined, undefined, "import_invalid", message)],
  });
  if (ts.version !== TYPESCRIPT_COMPILER_VERSION)
    return reject(
      "The trusted TypeScript compiler version does not match the pinned revision",
    );
  if (
    !isJsonObject(implementation) ||
    !isJsonObject(implementation.modules) ||
    jsonProblem(implementation, TYPESCRIPT_LIMITS.sourceBytes * 6 + 16384)
  )
    return reject("Source configuration must be bounded immutable JSON");
  if (
    typeof implementation.source !== "string" ||
    encoder.encode(implementation.source).length >
      TYPESCRIPT_LIMITS.entryBytes ||
    !/^(?:default|[a-zA-Z_$][a-zA-Z0-9_$]*)$/.test(implementation.entrypoint)
  )
    return reject("Entry source or export name exceeds its limits");
  const sources: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  sources[ENTRY_MODULE] = implementation.source;
  let sourceBytes = encoder.encode(implementation.source).length;
  if (
    Object.keys(implementation.modules).length + 1 >
    TYPESCRIPT_LIMITS.modules
  )
    return reject(
      "The source closure exceeds 32 files including the entry module",
    );
  try {
    for (const [path, source] of Object.entries(implementation.modules)) {
      const id = moduleId(path);
      if (own(sources, id) || typeof source !== "string")
        return reject("Module paths collide after canonicalization");
      sourceBytes += encoder.encode(source).length;
      if (sourceBytes > TYPESCRIPT_LIMITS.sourceBytes)
        return reject("The source closure exceeds 1 MiB");
      sources[id] = source;
    }
  } catch {
    return reject("The source closure contains an unsafe module path");
  }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noEmit: true,
    strictNullChecks: true,
    noImplicitAny: false,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: [],
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const files = new Map<string, ts.SourceFile>();
  try {
    for (const [id, source] of Object.entries(sources))
      files.set(
        id,
        ts.createSourceFile(
          id,
          source,
          options.target!,
          true,
          ts.ScriptKind.TS,
        ),
      );
  } catch {
    return reject(
      "The source cannot be parsed within the trusted compiler limits",
    );
  }
  const lib = ts.createSourceFile(
    "/@trusted/guest.d.ts",
    GUEST_LIB,
    options.target!,
    true,
    ts.ScriptKind.TS,
  );
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === lib.fileName ? lib : files.get(name)),
    getDefaultLibFileName: () => lib.fileName,
    writeFile: () => {
      throw new Error("Compiler output must use the immutable closure");
    },
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => name === lib.fileName || files.has(name),
    readFile: (name) => (name === lib.fileName ? GUEST_LIB : sources[name]),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names, containingFile) =>
      names.map((name) => {
        try {
          const id = resolveTypeScriptModule(containingFile, name);
          return own(sources, id)
            ? { resolvedFileName: id, extension: ts.Extension.Ts }
            : undefined;
        } catch {
          return undefined;
        }
      }),
  };
  const program = ts.createProgram(
    [...files.keys(), lib.fileName],
    options,
    host,
  );
  for (const item of program.getSyntacticDiagnostics()) {
    if (diagnostics.length >= 100) break;
    const position =
      item.file && item.start !== undefined
        ? item.file.getLineAndCharacterOfPosition(item.start)
        : { line: 0, character: 0 };
    diagnostics.push({
      code: `typescript_${item.code}`,
      module: item.file?.fileName ?? "/entry.ts",
      line: position.line + 1,
      column: position.character + 1,
      message: "TypeScript syntax check failed at this position",
    });
  }
  try {
    for (const file of files.values())
      inspectSource(file, sources, diagnostics);
  } catch {
    return reject("The source exceeds the trusted compiler syntax budget");
  }
  if (diagnostics.length)
    return { valid: false, diagnostics: diagnostics.slice(0, 100) };
  let compilerChecks = 0;
  const cancellation: ts.CancellationToken = {
    isCancellationRequested: () => ++compilerChecks > 100000,
    throwIfCancellationRequested() {
      if (this.isCancellationRequested())
        throw new Error("Trusted compiler budget exhausted");
    },
  };
  let checked: readonly ts.Diagnostic[];
  try {
    checked = ts.getPreEmitDiagnostics(program, undefined, cancellation);
  } catch {
    return reject("The source exceeds the trusted compiler type-check budget");
  }
  for (const item of checked) {
    if (
      item.category !== ts.DiagnosticCategory.Error ||
      diagnostics.length >= 100
    )
      continue;
    const position =
      item.file && item.start !== undefined
        ? item.file.getLineAndCharacterOfPosition(item.start)
        : { line: 0, character: 0 };
    // Diagnostics never echo source, literals, private IDs or authored strings.
    diagnostics.push({
      code: `typescript_${item.code}`,
      module: item.file?.fileName ?? ENTRY_MODULE,
      line: position.line + 1,
      column: position.character + 1,
      message: "TypeScript syntax or type check failed at this position",
    });
  }
  const checker = program.getTypeChecker(),
    entry = files.get(ENTRY_MODULE)!;
  const exports = checker.getSymbolAtLocation(entry);
  const symbol =
    exports &&
    checker
      .getExportsOfModule(exports)
      .find((item) => item.name === implementation.entrypoint);
  if (
    !symbol ||
    !checker.getTypeOfSymbolAtLocation(symbol, entry).getCallSignatures().length
  )
    diagnostics.push(
      diagnostic(
        entry,
        undefined,
        "import_invalid",
        "The entrypoint must name an exported callable function",
      ),
    );
  if (diagnostics.length)
    return { valid: false, diagnostics: diagnostics.slice(0, 100) };
  const modules: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [id, source] of Object.entries(sources).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const output = ts.transpileModule(source, {
      fileName: id,
      compilerOptions: {
        target: options.target,
        module: options.module,
        isolatedModules: true,
        removeComments: true,
        sourceMap: false,
        inlineSourceMap: false,
        importHelpers: false,
      },
      reportDiagnostics: true,
    });
    if (
      output.diagnostics?.some(
        (item) => item.category === ts.DiagnosticCategory.Error,
      )
    )
      return reject(
        "The module cannot be emitted for the pinned ES module runtime",
      );
    modules[id] = output.outputText;
  }
  const frame = {
    version: 1 as const,
    compilerVersion: TYPESCRIPT_COMPILER_VERSION,
    runtimeVersion: QUICKJS_RUNTIME_VERSION,
    entryModule: ENTRY_MODULE,
    entrypoint: implementation.entrypoint,
    modules,
    sourceDigest: await sha256(
      canonicalJson({
        entryModule: ENTRY_MODULE,
        entrypoint: implementation.entrypoint,
        modules: sources,
      }),
    ),
  };
  const artifactDigest = await sha256(canonicalJson(frame));
  const artifact: CompiledTypeScriptArtifact = { ...frame, artifactDigest };
  if (
    encoder.encode(canonicalJson(artifact)).length >
    TYPESCRIPT_LIMITS.artifactBytes
  )
    return reject("The immutable compiled artifact exceeds 1 MiB");
  Object.freeze(modules);
  Object.freeze(artifact);
  return { valid: true, artifact, diagnostics: [] };
}
