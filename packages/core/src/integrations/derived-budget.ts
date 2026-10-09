import { M2_LIMITS } from "@scaffold/schema/integrations";

export class DerivedMetadataBudgetError extends Error {
  readonly code = "import_invalid" as const;
  readonly status = 413;
  constructor() {
    super(
      "Derived Tool definitions and review metadata exceed the 8 MiB canonical JSON budget.",
    );
    this.name = "DerivedMetadataBudgetError";
  }
}

/** JCS fragments; large strings are escaped in bounded slices, never flattened as one JSON copy. */
export function* canonicalFragments(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    for (let start = 0; start < value.length; ) {
      let end = Math.min(start + 16384, value.length);
      if (
        end < value.length &&
        value.charCodeAt(end - 1) >= 0xd800 &&
        value.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
    return;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    yield JSON.stringify(value);
    return;
  }
  if (typeof value !== "object")
    throw new TypeError("Canonical metadata must contain JSON values.");
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      yield* canonicalFragments(value[index]);
    }
    yield "]";
    return;
  }
  yield "{";
  const keys = Object.keys(value).sort();
  for (const [index, key] of keys.entries()) {
    if (index) yield ",";
    yield* canonicalFragments(key);
    yield ":";
    yield* canonicalFragments(Reflect.get(value, key));
  }
  yield "}";
}

/** Incremental lower bound for resolver entries; the complete report is checked again with exact wrappers. */
export function createDerivedMetadataCounter() {
  const encoder = new TextEncoder();
  let bytes = 0;
  return {
    add(value: unknown): void {
      for (const fragment of canonicalFragments(value)) {
        bytes += encoder.encode(fragment).length;
        if (bytes > M2_LIMITS.derivedMetadataBytes)
          throw new DerivedMetadataBudgetError();
      }
    },
  };
}
export function assertDerivedMetadataBudget(value: unknown): void {
  createDerivedMetadataCounter().add(value);
}
