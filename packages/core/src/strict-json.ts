/** Reject duplicate object names before JCS fingerprinting can lose their meaning. */
export function parseStrictJson(source: string): unknown {
  const parsed: unknown = JSON.parse(source);
  let offset = 0;
  function whitespace() {
    while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++;
  }
  function string(): string {
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === "\\") offset++;
      else if (character === '"') break;
    }
    return JSON.parse(source.slice(start, offset)) as string;
  }
  function value(depth: number) {
    if (depth > 64) throw new SyntaxError("JSON nesting limit exceeded");
    whitespace();
    if (source[offset] === "{") {
      offset++;
      whitespace();
      const names = new Set<string>();
      while (source[offset] !== "}") {
        const name = string();
        if (names.has(name)) throw new SyntaxError("Duplicate JSON property");
        names.add(name);
        whitespace();
        offset++; // colon; JSON.parse has already validated grammar
        value(depth + 1);
        whitespace();
        if (source[offset] !== ",") break;
        offset++;
        whitespace();
      }
      offset++;
    } else if (source[offset] === "[") {
      offset++;
      whitespace();
      while (source[offset] !== "]") {
        value(depth + 1);
        whitespace();
        if (source[offset] !== ",") break;
        offset++;
      }
      offset++;
    } else if (source[offset] === '"') {
      string();
    } else {
      while (offset < source.length && !/[\s,\]}]/.test(source[offset] ?? ""))
        offset++;
    }
  }
  value(0);
  return parsed;
}

/** Bound bytes while reading, rather than trusting Content-Length or buffering arbitrarily. */
export async function readJsonBody(
  request: Request,
  limit = 1024 * 1024,
): Promise<unknown> {
  if (!request.body) throw new SyntaxError("JSON body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new RangeError("Payload limit exceeded");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(combined),
  );
}
