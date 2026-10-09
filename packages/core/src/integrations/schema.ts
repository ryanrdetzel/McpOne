import {
  hasCodeUnitInRange,
  isJsonObject,
  jsonProblem,
  M2_LIMITS,
} from "@scaffold/schema/integrations";
import { canonicalJson } from "../execution/canonical.js";

export type SchemaOptions = {
  dialect?: "3.0" | "3.1";
  direction?: "request" | "response";
};
export type SchemaIssue = {
  code: "unsupported_schema" | "schema_limit" | "invalid_arguments";
  path: string;
  schemaPath: string;
  keyword: string;
  message: string;
};
export type SchemaOutcome = {
  valid: boolean;
  issues: SchemaIssue[];
  warnings: SchemaIssue[];
};
type Schema = boolean | Record<string, unknown>;
type State = {
  test?: (character: string) => boolean;
  next?: number;
  epsilon: number[];
};
type Pattern = { states: State[]; start: boolean; end: boolean };
type DirectionalAnnotations = { readOnly: boolean; writeOnly: boolean };
type Compiled = {
  root: Schema;
  options: SchemaOptions;
  refs: Map<object, Schema>;
  paths: Map<object, string>;
  patterns: Map<object, Pattern>;
  nodes: Set<object>;
  directions: Map<object, DirectionalAnnotations>;
};
const own = (value: object, key: string) => Object.hasOwn(value, key);
const pointer = (base: string, key: string | number) =>
  `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const types: Record<string, true> = {
  string: true,
  number: true,
  integer: true,
  boolean: true,
  object: true,
  array: true,
  null: true,
};
const formats: Record<string, true> = {
  date: true,
  "date-time": true,
  uuid: true,
  email: true,
  uri: true,
  hostname: true,
  ipv4: true,
  ipv6: true,
};
const annotations: Record<string, true> = {
  default: true,
  examples: true,
  example: true,
  title: true,
  description: true,
  deprecated: true,
};
const keywords: Record<string, true> = Object.fromEntries(
  [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minimum",
    "maximum",
    "multipleOf",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "pattern",
    "format",
    "allOf",
    "oneOf",
    "anyOf",
    "nullable",
    "discriminator",
    "$ref",
    "$defs",
    "$schema",
    "$id",
    "readOnly",
    "writeOnly",
    ...Object.keys(annotations),
  ].map((key) => [key, true]),
);
class Rejection extends Error {
  constructor(readonly issue: SchemaIssue) {
    super(issue.message);
  }
}
function reject(
  code: SchemaIssue["code"],
  path: string,
  schemaPath: string,
  keyword: string,
  message: string,
): never {
  throw new Rejection({ code, path, schemaPath, keyword, message });
}

/** Thompson-style NFA; bounded expansion, no host regular-expression evaluation of patterns. */
function compilePattern(source: string): Pattern {
  if (source.length > 256 || hasCodeUnitInRange(source, 128, 65535))
    throw new Error("Pattern must contain at most 256 ASCII characters");
  let position = 0;
  const start = source.startsWith("^");
  if (start) position++;
  const states: State[] = [{ epsilon: [] }];
  let current = 0,
    end = false;
  function literal(): string {
    const character = source[position++];
    if (character === undefined) throw new Error("Missing pattern character");
    if (character !== "\\") return character;
    const escaped = source[position++];
    if (escaped === undefined || /[a-zA-Z0-9]/.test(escaped))
      throw new Error("Only escaped literal punctuation is supported");
    return escaped;
  }
  while (position < source.length) {
    if (source[position] === "$" && position === source.length - 1) {
      end = true;
      position++;
      break;
    }
    let test: (character: string) => boolean;
    const token = source[position];
    if (token === ".") {
      position++;
      test = (c) =>
        c !== "\n" && c !== "\r" && c !== "\u2028" && c !== "\u2029";
    } else if (token === "[") {
      position++;
      const negate = source[position] === "^";
      if (negate) position++;
      const ranges: [number, number][] = [];
      while (position < source.length && source[position] !== "]") {
        const first = literal().codePointAt(0)!;
        if (source[position] === "-" && source[position + 1] !== "]") {
          position++;
          const last = literal().codePointAt(0)!;
          if (last < first) throw new Error("Reversed character range");
          ranges.push([first, last]);
        } else ranges.push([first, first]);
      }
      if (source[position++] !== "]" || ranges.length === 0)
        throw new Error("Invalid character class");
      test = (c) => {
        const code = c.codePointAt(0)!;
        return ranges.some(([a, b]) => code >= a && code <= b) !== negate;
      };
    } else {
      if (token === undefined || "()|?*+{}^$]".includes(token))
        throw new Error("Unsupported pattern operator or nested quantifier");
      const character = literal();
      test = (c) => c === character;
    }
    let min = 1,
      max = 1;
    const quantifier = source[position];
    if (quantifier === "?" || quantifier === "*" || quantifier === "+") {
      position++;
      min = quantifier === "+" ? 1 : 0;
      max = quantifier === "?" ? 1 : Infinity;
    } else if (quantifier === "{") {
      position++;
      let digits = "";
      while (/[0-9]/.test(source[position] ?? "")) digits += source[position++];
      if (!digits) throw new Error("Missing repetition lower bound");
      min = Number(digits);
      max = min;
      if (source[position] === ",") {
        position++;
        digits = "";
        while (/[0-9]/.test(source[position] ?? ""))
          digits += source[position++];
        if (!digits) throw new Error("Missing repetition upper bound");
        max = Number(digits);
      }
      if (source[position++] !== "}" || min > max || max > 1024)
        throw new Error("Repetition bounds must be ordered and at most 1024");
    }
    if (
      states.length + (max === Infinity ? min + 1 : max) >
      M2_LIMITS.patternStates
    )
      throw new Error("Expanded pattern exceeds 65536 NFA states");
    for (let repeat = 0; repeat < min; repeat++) {
      const next = states.length;
      const state = states[current]!;
      state.test = test;
      state.next = next;
      states.push({ epsilon: [] });
      current = next;
    }
    if (max === Infinity) {
      const next = states.length;
      const state = states[current]!;
      state.test = test;
      state.next = current;
      state.epsilon.push(next);
      states.push({ epsilon: [] });
      current = next;
    } else
      for (let repeat = min; repeat < max; repeat++) {
        const next = states.length;
        const state = states[current]!;
        state.test = test;
        state.next = next;
        state.epsilon.push(next);
        states.push({ epsilon: [] });
        current = next;
      }
  }
  return { states, start, end };
}
function matchesPattern(
  pattern: Pattern,
  value: string,
  charge: (amount: number) => void,
): boolean {
  const { states } = pattern;
  let active = new Set<number>();
  function closure(input: Set<number>): Set<number> {
    const pending = [...input];
    while (pending.length) {
      const state = pending.pop()!;
      charge(1);
      for (const next of states[state]!.epsilon)
        if (!input.has(next)) {
          input.add(next);
          pending.push(next);
        }
    }
    return input;
  }
  active.add(0);
  closure(active);
  if (!pattern.end && active.has(states.length - 1)) return true;
  for (const character of value) {
    if (!pattern.start) {
      active.add(0);
      closure(active);
    }
    const next = new Set<number>();
    for (const state of active) {
      charge(1);
      const node = states[state]!;
      if (node.test?.(character)) next.add(node.next!);
    }
    active = closure(next);
    if (!pattern.end && active.has(states.length - 1)) return true;
  }
  if (!pattern.start) {
    active.add(0);
    closure(active);
  }
  return active.has(states.length - 1);
}
function validFormat(format: string, value: string): boolean {
  function date(s: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const year = Number(s.slice(0, 4)),
      month = Number(s.slice(5, 7)),
      day = Number(s.slice(8, 10));
    const lengths = [
      31,
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    return month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1]!;
  }
  function hostname(s: string): boolean {
    if (!s || s.length > 253) return false;
    return s
      .split(".")
      .every(
        (label) =>
          label.length <= 63 &&
          /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
      );
  }
  function ipv4(s: string): boolean {
    const parts = s.split(".");
    return (
      parts.length === 4 &&
      parts.every((p) => /^(?:0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)
    );
  }
  switch (format) {
    case "date":
      return date(value);
    case "date-time": {
      const match =
        /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
          value,
        );
      return (
        !!match &&
        date(match[1]!) &&
        Number(match[2]) <= 23 &&
        Number(match[3]) <= 59 &&
        Number(match[4]) <= 59 &&
        (!match[5] || (Number(match[6]) <= 23 && Number(match[7]) <= 59))
      );
    }
    case "uuid":
      return /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
        value,
      );
    case "hostname":
      return hostname(value);
    case "email": {
      const parts = value.split("@");
      return (
        parts.length === 2 &&
        /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(
          parts[0]!,
        ) &&
        parts[1]!.includes(".") &&
        hostname(parts[1]!)
      );
    }
    case "uri": {
      const match =
        /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
          value,
        );
      if (!match || /[^\x21-\x7e]/.test(value)) return false;
      function characters(part: string, extra: string): boolean {
        for (let index = 0; index < part.length; index++) {
          const character = part[index]!,
            code = part.charCodeAt(index);
          if (character === "%") {
            if (!/^[a-fA-F0-9]{2}$/.test(part.slice(index + 1, index + 3)))
              return false;
            index += 2;
          } else if (
            !(
              (code >= 65 && code <= 90) ||
              (code >= 97 && code <= 122) ||
              (code >= 48 && code <= 57)
            ) &&
            !("-._~!$&'()*+,;=" + extra).includes(character)
          )
            return false;
        }
        return true;
      }
      if (
        !characters(match[3]!, ":@/") ||
        !characters(match[4] ?? "", ":@/?") ||
        !characters(match[5] ?? "", ":@/?")
      )
        return false;
      if (match[2] !== undefined) {
        let authority = match[2];
        const at = authority.lastIndexOf("@");
        if (at >= 0) {
          if (!characters(authority.slice(0, at), ":")) return false;
          authority = authority.slice(at + 1);
        }
        if (authority.startsWith("[")) {
          const end = authority.indexOf("]"),
            literal = authority.slice(1, end);
          if (
            end < 0 ||
            (authority.slice(end + 1) &&
              !/^:\d*$/.test(authority.slice(end + 1)))
          )
            return false;
          if (/^v[a-f0-9]+\./i.test(literal)) {
            const dot = literal.indexOf(".");
            if (
              !literal.slice(dot + 1) ||
              literal.includes("%") ||
              !characters(literal.slice(dot + 1), ":")
            )
              return false;
          } else if (!validFormat("ipv6", literal)) return false;
        } else {
          const colon = authority.lastIndexOf(":");
          if (colon >= 0) {
            if (!/^\d*$/.test(authority.slice(colon + 1))) return false;
            authority = authority.slice(0, colon);
          }
          if (!characters(authority, "")) return false;
        }
        if (match[3] && !match[3].startsWith("/")) return false;
      }
      return true;
    }
    case "ipv4":
      return ipv4(value);
    case "ipv6": {
      if (value.length > 45) return false;
      if (!/^[a-fA-F0-9:.]+$/.test(value) || value.includes(":::"))
        return false;
      let source = value;
      if (source.includes(".")) {
        const last = source.lastIndexOf(":");
        const tail = source.slice(last + 1);
        if (!ipv4(tail)) return false;
        const octets = tail.split(".").map(Number);
        source =
          source.slice(0, last + 1) +
          ((octets[0]! << 8) | octets[1]!).toString(16) +
          ":" +
          ((octets[2]! << 8) | octets[3]!).toString(16);
      }
      const halves = source.split("::");
      if (halves.length > 2) return false;
      const left = halves[0] ? halves[0].split(":") : [],
        right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
      if (![...left, ...right].every((p) => /^[a-fA-F0-9]{1,4}$/.test(p)))
        return false;
      if (
        halves.length === 1
          ? left.length !== 8
          : left.length + right.length >= 8
      )
        return false;
      return true;
    }
    default:
      return false;
  }
}
function decimal(value: number): { coefficient: bigint; scale: number } {
  const parts = JSON.stringify(value).toLowerCase().split("e");
  const mantissa = parts[0]!,
    exponent = parts[1] ?? "0";
  const point = mantissa.indexOf(".");
  return {
    coefficient: BigInt(mantissa.replace(".", "")),
    scale: Number(exponent) - (point < 0 ? 0 : mantissa.length - point - 1),
  };
}
function multipleOf(value: number, divisor: number): boolean {
  const a = decimal(value),
    b = decimal(divisor),
    scale = Math.min(a.scale, b.scale);
  return (
    (a.coefficient * 10n ** BigInt(a.scale - scale)) %
      (b.coefficient * 10n ** BigInt(b.scale - scale)) ===
    0n
  );
}
function resolve(root: Schema, reference: string, path: string): Schema {
  if (!reference.startsWith("#/"))
    reject(
      "unsupported_schema",
      "",
      path,
      "$ref",
      "Only local JSON Pointer references are accepted; external references must be snapshotted by the importer",
    );
  let current: unknown = root;
  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(2));
  } catch {
    reject(
      "unsupported_schema",
      "",
      path,
      "$ref",
      "Malformed JSON Pointer URI fragment",
    );
  }
  for (const token of fragment!.split("/")) {
    if (/~(?![01])/.test(token))
      reject(
        "unsupported_schema",
        "",
        path,
        "$ref",
        "Malformed JSON Pointer escape",
      );
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null || !own(current, key))
      reject(
        "unsupported_schema",
        "",
        path,
        "$ref",
        "Reference target does not exist",
      );
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== "boolean" && !isJsonObject(current))
    reject(
      "unsupported_schema",
      "",
      path,
      "$ref",
      "Reference target is not a schema",
    );
  return current as Schema;
}
/** A missing property is optional directionally only when every alternative establishes the flag. */
function staticDirections(
  compiled: Compiled,
  schema: Schema,
): DirectionalAnnotations {
  if (typeof schema === "boolean") return { readOnly: false, writeOnly: false };
  const cached = compiled.directions.get(schema);
  if (cached) return cached;
  const result = {
    readOnly: schema.readOnly === true,
    writeOnly: schema.writeOnly === true,
  };
  const referenced = compiled.refs.get(schema);
  if (referenced !== undefined) {
    const flags = staticDirections(compiled, referenced);
    result.readOnly ||= flags.readOnly;
    result.writeOnly ||= flags.writeOnly;
  }
  if (Array.isArray(schema.allOf))
    for (const branch of schema.allOf as Schema[]) {
      const flags = staticDirections(compiled, branch);
      result.readOnly ||= flags.readOnly;
      result.writeOnly ||= flags.writeOnly;
    }
  for (const key of ["anyOf", "oneOf"])
    if (Array.isArray(schema[key])) {
      const branches = (schema[key] as Schema[]).filter(
        (branch) => branch !== false,
      );
      if (branches.length) {
        const flags = branches.map((branch) =>
          staticDirections(compiled, branch),
        );
        result.readOnly ||= flags.every((flag) => flag.readOnly);
        result.writeOnly ||= flags.every((flag) => flag.writeOnly);
      }
    }
  compiled.directions.set(schema, result);
  return result;
}
function compile(schema: unknown, options: SchemaOptions): Compiled {
  if (
    options.dialect !== undefined &&
    options.dialect !== "3.0" &&
    options.dialect !== "3.1"
  )
    reject("unsupported_schema", "", "", "$schema", "Unsupported dialect");
  if (
    options.direction !== undefined &&
    options.direction !== "request" &&
    options.direction !== "response"
  )
    reject(
      "unsupported_schema",
      "",
      "",
      "direction",
      "Unsupported validation direction",
    );
  if (jsonProblem(schema, M2_LIMITS.documentBytes, 128))
    reject(
      "schema_limit",
      "",
      "",
      "schema",
      "Schema must be bounded valid JSON",
    );
  const compiled: Compiled = {
    root: schema as Schema,
    options,
    refs: new Map(),
    paths: new Map(),
    patterns: new Map(),
    nodes: new Set(),
    directions: new Map(),
  };
  const dialect = options.dialect ?? "3.1",
    active = new Set<object>();
  const booleanPaths = new Set<string>();
  let traversals = 0,
    references = 0;
  function walk(
    value: unknown,
    path: string,
    depth: number,
    compositions: number,
    refDepth: number,
  ): void {
    const fail = (keyword: string, message: string, limit = false): never =>
      reject(
        limit ? "schema_limit" : "unsupported_schema",
        "",
        pointer(path, keyword),
        keyword,
        message,
      );
    if (++traversals > 100000 || depth > 32)
      fail("schema", "Schema traversal/depth limit exceeded", true);
    if (typeof value === "boolean") {
      if (dialect === "3.0")
        fail("schema", "Boolean schemas require dialect 3.1");
      booleanPaths.add(
        path.startsWith("#") ? decodeURIComponent(path.slice(1)) : path,
      );
      if (compiled.nodes.size + booleanPaths.size > M2_LIMITS.schemaNodes)
        fail("schema", "Schema node limit exceeded", true);
      return;
    }
    if (!isJsonObject(value)) fail("schema", "Expected a schema object");
    const s = value as Record<string, unknown>;
    if (active.has(s)) fail("$ref", "Cyclic schema reference");
    const first = !compiled.nodes.has(s);
    compiled.nodes.add(s);
    if (compiled.nodes.size + booleanPaths.size > M2_LIMITS.schemaNodes)
      fail("schema", "Schema node limit exceeded", true);
    if (first) compiled.paths.set(s, path);
    active.add(s);
    for (const key of Object.keys(s))
      if (!own(keywords, key) && !key.startsWith("x-"))
        fail(key, "Unsupported schema keyword");
    if (
      own(s, "$schema") &&
      (dialect === "3.0" ||
        s.$schema !== "https://json-schema.org/draft/2020-12/schema")
    )
      fail("$schema", "Unsupported schema dialect declaration");
    if (own(s, "$id") && s.$id !== "")
      fail("$id", "Schema IDs that change reference base are unsupported");
    if (own(s, "type")) {
      const entries = Array.isArray(s.type) ? s.type : [s.type];
      if (
        (dialect === "3.0" && (Array.isArray(s.type) || s.type === "null")) ||
        !entries.length ||
        entries.length > 8 ||
        new Set(entries).size !== entries.length ||
        entries.some((t) => typeof t !== "string" || !own(types, t))
      )
        fail("type", "Invalid type declaration for selected dialect");
    }
    if (
      own(s, "nullable") &&
      (dialect !== "3.0" || typeof s.nullable !== "boolean" || !own(s, "type"))
    )
      fail(
        "nullable",
        "nullable is boolean with explicit sibling type in dialect 3.0 only",
      );
    for (const key of ["readOnly", "writeOnly", "deprecated", "uniqueItems"])
      if (own(s, key) && typeof s[key] !== "boolean")
        fail(key, "Expected boolean");
    if (s.readOnly === true && s.writeOnly === true)
      fail("readOnly", "readOnly and writeOnly cannot both be true");
    for (const key of ["title", "description"])
      if (own(s, key) && typeof s[key] !== "string")
        fail(key, "Expected string annotation");
    if (own(s, "examples") && !Array.isArray(s.examples))
      fail("examples", "Expected annotation array");
    for (const key of ["minimum", "maximum", "multipleOf"])
      if (
        own(s, key) &&
        (typeof s[key] !== "number" ||
          !Number.isFinite(s[key]) ||
          (key === "multipleOf" && (s[key] as number) <= 0))
      )
        fail(key, "Expected finite numeric bound; multipleOf must be positive");
    for (const [exclusive, inclusive] of [
      ["exclusiveMinimum", "minimum"],
      ["exclusiveMaximum", "maximum"],
    ] as const)
      if (
        own(s, exclusive) &&
        (dialect === "3.0"
          ? typeof s[exclusive] !== "boolean" || !own(s, inclusive)
          : typeof s[exclusive] !== "number" || !Number.isFinite(s[exclusive]))
      )
        fail(exclusive, "Invalid exclusive bound for selected dialect");
    for (const [min, max] of [
      ["minLength", "maxLength"],
      ["minItems", "maxItems"],
      ["minProperties", "maxProperties"],
    ] as const) {
      for (const key of [min, max])
        if (
          own(s, key) &&
          (typeof s[key] !== "number" ||
            !Number.isSafeInteger(s[key]) ||
            (s[key] as number) < 0)
        )
          fail(key, "Expected nonnegative bounded integer");
      if (own(s, min) && own(s, max) && (s[min] as number) > (s[max] as number))
        fail(min, "Minimum exceeds maximum");
    }
    if (own(s, "enum")) {
      if (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 256)
        fail(
          "enum",
          "enum requires 1–256 entries",
          Array.isArray(s.enum) && s.enum.length > 256,
        );
      const entries = (s.enum as unknown[]).map(canonicalJson);
      if (new Set(entries).size !== entries.length)
        fail("enum", "enum entries must be structurally unique");
    }
    if (own(s, "const") && dialect === "3.0")
      fail(
        "const",
        "const is unsupported in dialect 3.0; explicitly normalize to enum",
      );
    if (
      own(s, "format") &&
      (typeof s.format !== "string" || !own(formats, s.format))
    )
      fail("format", "Unsupported format assertion");
    if (own(s, "pattern")) {
      if (typeof s.pattern !== "string")
        fail("pattern", "Expected pattern string");
      if (first) {
        try {
          compiled.patterns.set(s, compilePattern(s.pattern as string));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unsupported pattern";
          fail(
            "pattern",
            message,
            message.startsWith("Expanded pattern exceeds"),
          );
        }
      }
    }
    if (own(s, "properties")) {
      if (!isJsonObject(s.properties))
        fail("properties", "Expected property-schema map");
      const properties = s.properties as Record<string, unknown>;
      if (Object.keys(properties).length > 256)
        fail("properties", "At most 256 properties", true);
      for (const key of Object.keys(properties))
        walk(
          properties[key],
          pointer(pointer(path, "properties"), key),
          depth + 1,
          compositions,
          refDepth,
        );
    }
    if (own(s, "required")) {
      if (
        !Array.isArray(s.required) ||
        s.required.length > 256 ||
        new Set(s.required).size !== s.required.length ||
        s.required.some(
          (k) =>
            typeof k !== "string" ||
            !isJsonObject(s.properties) ||
            !own(s.properties, k),
        )
      )
        fail(
          "required",
          "required must contain unique declared property names",
        );
    }
    for (const key of ["items", "additionalProperties"])
      if (own(s, key)) {
        if (key === "additionalProperties" && typeof s[key] === "boolean") {
          booleanPaths.add(
            pointer(
              path.startsWith("#") ? decodeURIComponent(path.slice(1)) : path,
              key,
            ),
          );
          if (compiled.nodes.size + booleanPaths.size > M2_LIMITS.schemaNodes)
            fail("schema", "Schema node limit exceeded", true);
          continue; // This keyword accepts booleans even in the 3.0 Schema Object dialect.
        }
        walk(s[key], pointer(path, key), depth + 1, compositions, refDepth);
      }
    if (own(s, "$defs")) {
      if (dialect === "3.0" || !isJsonObject(s.$defs))
        fail("$defs", "$defs requires a schema map in dialect 3.1");
      for (const key of Object.keys(s.$defs as object))
        walk(
          (s.$defs as Record<string, unknown>)[key],
          pointer(pointer(path, "$defs"), key),
          depth + 1,
          compositions,
          refDepth,
        );
    }
    for (const key of ["allOf", "anyOf", "oneOf"])
      if (own(s, key)) {
        const branches = s[key];
        if (!Array.isArray(branches) || !branches.length || branches.length > 8)
          fail(
            key,
            "Composition requires 1–8 branches",
            Array.isArray(branches) && branches.length > 8,
          );
        if (compositions >= 4)
          fail(key, "At most four nested composition levels", true);
        (branches as unknown[]).forEach((branch, index) => {
          walk(
            branch,
            pointer(pointer(path, key), index),
            depth + 1,
            compositions + 1,
            refDepth,
          );
        });
      }
    if (own(s, "$ref")) {
      if (typeof s.$ref !== "string") fail("$ref", "Expected reference string");
      if (
        dialect === "3.0" &&
        Object.keys(s).some(
          (k) => k !== "$ref" && !own(annotations, k) && !k.startsWith("x-"),
        )
      )
        fail(
          "$ref",
          "Dialect 3.0 reference validation siblings are unsupported",
        );
      if (first && ++references > 1000)
        fail("$ref", "Reference occurrence limit exceeded", true);
      if (refDepth >= 10)
        fail("$ref", "At most ten dereferences per path", true);
      const target = resolve(
        compiled.root,
        s.$ref as string,
        pointer(path, "$ref"),
      );
      compiled.refs.set(s, target);
      walk(
        target,
        decodeURIComponent((s.$ref as string).slice(1)),
        depth + 1,
        compositions,
        refDepth + 1,
      );
    }
    if (own(s, "discriminator")) {
      const d = s.discriminator;
      if (
        !isJsonObject(d) ||
        typeof d.propertyName !== "string" ||
        !isJsonObject(d.mapping) ||
        Object.keys(d).some((k) => k !== "propertyName" && k !== "mapping") ||
        own(s, "oneOf") === own(s, "anyOf")
      )
        fail(
          "discriminator",
          "Explicit propertyName/mapping with exactly one oneOf or anyOf is required",
        );
      const disc = d as {
        propertyName: string;
        mapping: Record<string, unknown>;
      };
      const branches = (s.oneOf ?? s.anyOf) as Schema[],
        tags = new Set<string>();
      if (Object.keys(disc.mapping).length !== branches.length)
        fail("discriminator", "Every branch must have exactly one mapped tag");
      for (const branch of branches) {
        let target = branch;
        const seen = new Set<object>();
        while (typeof target === "object" && compiled.refs.has(target)) {
          if (seen.has(target))
            fail("discriminator", "Cyclic discriminator branch");
          seen.add(target);
          target = compiled.refs.get(target)!;
        }
        if (
          typeof target !== "object" ||
          target.type !== "object" ||
          !Array.isArray(target.required) ||
          !target.required.includes(disc.propertyName) ||
          !isJsonObject(target.properties)
        )
          fail(
            "discriminator",
            "Every branch must require the object discriminator property",
          );
        const tagSchema = (target as Record<string, unknown>)
          .properties as Record<string, unknown>;
        let tag = tagSchema[disc.propertyName] as Schema;
        while (
          typeof tag === "object" &&
          !own(tag, "const") &&
          !(Array.isArray(tag.enum) && tag.enum.length === 1) &&
          compiled.refs.has(tag)
        )
          tag = compiled.refs.get(tag)!;
        if (!isJsonObject(tag))
          fail("discriminator", "Tag must be a singleton string const or enum");
        const name = own(tag as object, "const")
          ? (tag as Record<string, unknown>).const
          : Array.isArray((tag as Record<string, unknown>).enum) &&
              ((tag as Record<string, unknown>).enum as unknown[]).length === 1
            ? ((tag as Record<string, unknown>).enum as unknown[])[0]
            : undefined;
        if (
          typeof name !== "string" ||
          tags.has(name) ||
          !own(disc.mapping, name) ||
          typeof disc.mapping[name] !== "string"
        )
          fail(
            "discriminator",
            "Discriminator tags must be disjoint mapped singleton strings",
          );
        tags.add(name as string);
        let mapped = resolve(
          compiled.root,
          disc.mapping[name as string] as string,
          pointer(path, "discriminator"),
        );
        while (typeof mapped === "object" && compiled.refs.has(mapped))
          mapped = compiled.refs.get(mapped)!;
        if (mapped !== target)
          fail("discriminator", "Mapping must resolve to its exact branch");
      }
    }
    active.delete(s);
  }
  walk(schema, "", 0, 0, 0);
  for (const node of compiled.nodes) {
    const flags = staticDirections(compiled, node as Schema);
    if (flags.readOnly && flags.writeOnly)
      reject(
        "unsupported_schema",
        "",
        pointer(compiled.paths.get(node) ?? "", "readOnly"),
        "readOnly",
        "Conjunctive schema annotations cannot establish both readOnly and writeOnly",
      );
  }
  return compiled;
}

type EvaluationBudget = { visits: number; processing: number };
function evaluate(
  compiled: Compiled,
  value: unknown,
  initial: Schema = compiled.root,
  initialPath = "",
  budget: EvaluationBudget = { visits: 0, processing: 0 },
): SchemaIssue[] {
  const direction = compiled.options.direction ?? "request",
    dialect = compiled.options.dialect ?? "3.1";
  type Evaluation = DirectionalAnnotations & { issues: SchemaIssue[] };
  function walk(
    schema: Schema,
    input: unknown,
    path: string,
    schemaPath: string,
  ): Evaluation {
    if (++budget.visits > M2_LIMITS.validationVisits)
      reject(
        "schema_limit",
        path,
        schemaPath,
        "budget",
        "Validation exceeds 100000 schema-node/instance-pair visits",
      );
    if (schema === true)
      return { issues: [], readOnly: false, writeOnly: false };
    if (schema === false)
      return {
        issues: [
          {
            code: "invalid_arguments",
            path,
            schemaPath,
            keyword: "false",
            message: "Value is rejected by false schema",
          },
        ],
        readOnly: false,
        writeOnly: false,
      };
    const s = schema,
      issues: SchemaIssue[] = [];
    let readOnly = s.readOnly === true,
      writeOnly = s.writeOnly === true;
    const issue = (keyword: string, message: string, at = path): void => {
      if (issues.length < 64)
        issues.push({
          code: "invalid_arguments",
          path: at,
          schemaPath: pointer(schemaPath, keyword),
          keyword,
          message,
        });
    };
    const charge = (amount: number): void => {
      budget.processing += amount;
      if (budget.processing > M2_LIMITS.validationWork)
        reject(
          "schema_limit",
          path,
          schemaPath,
          "budget",
          "String/structural validation work exceeds bounded processing budget",
        );
    };
    const append = (children: SchemaIssue[]): void => {
      for (const child of children) if (issues.length < 64) issues.push(child);
    };
    if (compiled.refs.has(s)) {
      const child = walk(
        compiled.refs.get(s)!,
        input,
        path,
        decodeURIComponent(String(s.$ref).slice(1)),
      );
      append(child.issues);
      if (!child.issues.length) {
        readOnly ||= child.readOnly;
        writeOnly ||= child.writeOnly;
      }
    }
    if (own(s, "type")) {
      const declared = Array.isArray(s.type) ? s.type : [s.type];
      const actual =
        input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
      if (
        !declared.includes(actual) &&
        !(
          actual === "number" &&
          declared.includes("integer") &&
          Number.isInteger(input)
        ) &&
        !(input === null && dialect === "3.0" && s.nullable === true)
      )
        issue("type", "Value has an incompatible JSON type");
    }
    if (own(s, "enum") || own(s, "const")) {
      const encoded = canonicalJson(input);
      charge(encoded.length);
      if (
        own(s, "enum") &&
        !(s.enum as unknown[]).some((candidate) => {
          const canonical = canonicalJson(candidate);
          charge(canonical.length);
          return canonical === encoded;
        })
      )
        issue("enum", "Value is not an allowed enum member");
      if (own(s, "const")) {
        const canonical = canonicalJson(s.const);
        charge(canonical.length);
        if (canonical !== encoded) issue("const", "Value does not match const");
      }
    }
    if (typeof input === "number") {
      if (
        typeof s.minimum === "number" &&
        (input < s.minimum ||
          (dialect === "3.0" &&
            s.exclusiveMinimum === true &&
            input === s.minimum))
      )
        issue("minimum", "Value is below minimum");
      if (
        typeof s.maximum === "number" &&
        (input > s.maximum ||
          (dialect === "3.0" &&
            s.exclusiveMaximum === true &&
            input === s.maximum))
      )
        issue("maximum", "Value is above maximum");
      if (
        dialect === "3.1" &&
        typeof s.exclusiveMinimum === "number" &&
        input <= s.exclusiveMinimum
      )
        issue("exclusiveMinimum", "Value must exceed exclusive minimum");
      if (
        dialect === "3.1" &&
        typeof s.exclusiveMaximum === "number" &&
        input >= s.exclusiveMaximum
      )
        issue("exclusiveMaximum", "Value must be below exclusive maximum");
      if (typeof s.multipleOf === "number" && !multipleOf(input, s.multipleOf))
        issue("multipleOf", "Value is not an exact decimal multiple");
    }
    if (typeof input === "string") {
      let length = 0;
      for (const unused of input) {
        void unused;
        length++;
      }
      charge(input.length);
      if (typeof s.minLength === "number" && length < s.minLength)
        issue("minLength", "String is too short");
      if (typeof s.maxLength === "number" && length > s.maxLength)
        issue("maxLength", "String is too long");
      if (
        compiled.patterns.has(s) &&
        !matchesPattern(compiled.patterns.get(s)!, input, charge)
      )
        issue("pattern", "String does not match pattern");
      if (typeof s.format === "string" && !validFormat(s.format, input))
        issue("format", "String does not match asserted format");
    }
    if (Array.isArray(input)) {
      if (typeof s.minItems === "number" && input.length < s.minItems)
        issue("minItems", "Array has too few items");
      if (typeof s.maxItems === "number" && input.length > s.maxItems)
        issue("maxItems", "Array has too many items");
      if (s.uniqueItems === true) {
        const seen = new Set<string>();
        for (const child of input) {
          const key = canonicalJson(child);
          charge(key.length + 1);
          if (seen.has(key)) {
            issue("uniqueItems", "Array members must be structurally unique");
            break;
          }
          seen.add(key);
        }
      }
      if (own(s, "items"))
        for (let index = 0; index < input.length; index++)
          append(
            walk(
              s.items as Schema,
              input[index],
              pointer(path, index),
              pointer(schemaPath, "items"),
            ).issues,
          );
    }
    if (isJsonObject(input)) {
      const keys = Object.keys(input),
        properties = isJsonObject(s.properties)
          ? s.properties
          : (Object.create(null) as Record<string, unknown>);
      if (typeof s.minProperties === "number" && keys.length < s.minProperties)
        issue("minProperties", "Object has too few properties");
      if (typeof s.maxProperties === "number" && keys.length > s.maxProperties)
        issue("maxProperties", "Object has too many properties");
      if (Array.isArray(s.required))
        for (const key of s.required as string[])
          if (!own(input, key)) {
            const flags = staticDirections(compiled, properties[key] as Schema);
            if (!(direction === "request" ? flags.readOnly : flags.writeOnly))
              issue(
                "required",
                "Required property is missing",
                pointer(path, key),
              );
          }
      for (const key of keys) {
        charge(1);
        if (own(properties, key)) {
          const child = walk(
            properties[key] as Schema,
            input[key],
            pointer(path, key),
            pointer(pointer(schemaPath, "properties"), key),
          );
          append(child.issues);
          if (
            !child.issues.length &&
            (direction === "request" ? child.readOnly : child.writeOnly)
          )
            issue(
              direction === "request" ? "readOnly" : "writeOnly",
              "Property is forbidden in this validation direction",
              pointer(path, key),
            );
        } else if (s.additionalProperties === false)
          issue(
            "additionalProperties",
            "Undeclared property is not permitted",
            pointer(path, key),
          );
        else if (
          typeof s.additionalProperties === "object" ||
          s.additionalProperties === true
        ) {
          const child = walk(
            s.additionalProperties as Schema,
            input[key],
            pointer(path, key),
            pointer(schemaPath, "additionalProperties"),
          );
          append(child.issues);
          if (
            !child.issues.length &&
            (direction === "request" ? child.readOnly : child.writeOnly)
          )
            issue(
              direction === "request" ? "readOnly" : "writeOnly",
              "Property is forbidden in this validation direction",
              pointer(path, key),
            );
        }
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf"])
      if (Array.isArray(s[key])) {
        let successes = 0,
          branchReadOnly = false,
          branchWriteOnly = false;
        const branches = s[key] as Schema[];
        for (let index = 0; index < branches.length; index++) {
          const branch = walk(
            branches[index]!,
            input,
            path,
            pointer(pointer(schemaPath, key), index),
          );
          if (!branch.issues.length) {
            successes++;
            branchReadOnly ||= branch.readOnly;
            branchWriteOnly ||= branch.writeOnly;
          }
        }
        const matched =
          key === "allOf"
            ? successes === branches.length
            : key === "oneOf"
              ? successes === 1
              : successes > 0;
        if (!matched)
          issue(
            key,
            key === "oneOf"
              ? "Value must match exactly one branch"
              : key === "allOf"
                ? "Value must match every branch"
                : "Value must match at least one branch",
          );
        else {
          readOnly ||= branchReadOnly;
          writeOnly ||= branchWriteOnly;
        }
      }
    if (!issues.length && readOnly && writeOnly)
      issue(
        "readOnly",
        "Successful schema paths cannot establish both readOnly and writeOnly",
      );
    return {
      issues,
      readOnly: !issues.length && readOnly,
      writeOnly: !issues.length && writeOnly,
    };
  }
  return walk(
    initial,
    value,
    initialPath,
    typeof initial === "object" ? (compiled.paths.get(initial) ?? "") : "",
  ).issues;
}
function warningsFor(compiled: Compiled): SchemaIssue[] {
  const warnings: SchemaIssue[] = [];
  const budget: EvaluationBudget = { visits: 0, processing: 0 };
  for (const node of compiled.nodes) {
    const s = node as Record<string, unknown>;
    for (const keyword of ["default", "example", "examples"])
      if (own(s, keyword)) {
        const values =
          keyword === "examples" ? (s.examples as unknown[]) : [s[keyword]];
        for (const value of values) {
          try {
            if (evaluate(compiled, value, s, "", budget).length)
              warnings.push({
                code: "invalid_arguments",
                path: "",
                schemaPath: pointer(compiled.paths.get(s) ?? "", keyword),
                keyword,
                message:
                  "Annotation does not satisfy its schema; no value is injected",
              });
          } catch (error) {
            if (!(error instanceof Rejection)) throw error;
            warnings.push({
              ...error.issue,
              keyword,
              message:
                "Annotation validation exceeds a bound; no value is injected",
            });
            return warnings;
          }
          if (warnings.length >= 64) return warnings;
        }
      }
  }
  return warnings;
}
export function validateSchema(
  schema: unknown,
  options: SchemaOptions = {},
): SchemaOutcome {
  try {
    const compiled = compile(schema, options);
    return { valid: true, issues: [], warnings: warningsFor(compiled) };
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    return { valid: false, issues: [error.issue], warnings: [] };
  }
}
export function validateInput(
  schema: unknown,
  value: unknown,
  options: SchemaOptions = {},
): SchemaOutcome {
  try {
    const compiled = compile(schema, options);
    if (jsonProblem(value))
      reject(
        "invalid_arguments",
        "",
        "",
        "json",
        "Input must be bounded, finite, valid Unicode JSON",
      );
    const issues = evaluate(compiled, value);
    return {
      valid: issues.length === 0,
      issues,
      warnings: warningsFor(compiled),
    };
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    return { valid: false, issues: [error.issue], warnings: [] };
  }
}
