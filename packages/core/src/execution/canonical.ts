/** RFC 8785 JSON canonicalization: ECMAScript numbers, UTF-16 key ordering, no Unicode repair. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Non-finite JSON number");
      return JSON.stringify(item);
    }
    if (typeof item === "string") {
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = item.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff))
            throw new TypeError("Invalid Unicode string");
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          throw new TypeError("Invalid Unicode string");
        }
      }
      return JSON.stringify(item);
    }
    if (typeof item !== "object" || item === undefined)
      throw new TypeError("Value is not JSON");
    if (ancestors.has(item)) throw new TypeError("Cyclic JSON");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = `[${Array.from(item, (child) => encode(child)).join(",")}]`;
    } else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new TypeError("Value is not a JSON object");
      }
      const object = item as Record<string, unknown>;
      result = `{${Object.keys(object)
        .sort()
        .map((key) => `${encode(key)}:${encode(object[key])}`)
        .join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
