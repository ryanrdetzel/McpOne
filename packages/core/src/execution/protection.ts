/** Encryption keys are dependency-injected; no bindings, environment reads, or plaintext logging. */
export function createPayloadProtection(secret: string) {
  // Production entropy is enforced by the runtime config boundary; local bindings are public.
  if (secret.length === 0)
    throw new Error(
      "Execution payload protection requires a configured secret",
    );
  const encoder = new TextEncoder();
  const key = crypto.subtle
    .digest("SHA-256", encoder.encode(`mcpone/control/payload/v1:${secret}`))
    .then((bytes) =>
      crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    );
  async function encrypt(
    orgId: string,
    runId: string,
    kind: "request" | "result",
    value: unknown,
  ): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode(
            JSON.stringify(["v1", orgId, runId, kind]),
          ),
        },
        await key,
        encoder.encode(JSON.stringify(value)),
      ),
    );
    const packed = new Uint8Array(iv.length + bytes.length);
    packed.set(iv);
    packed.set(bytes, iv.length);
    let binary = "";
    for (let start = 0; start < packed.length; start += 8192) {
      binary += String.fromCharCode(...packed.subarray(start, start + 8192));
    }
    return `v1.${btoa(binary)}`;
  }
  async function decrypt<T>(
    orgId: string,
    runId: string,
    kind: "request" | "result",
    ciphertext: string,
  ): Promise<T> {
    if (!ciphertext.startsWith("v1."))
      throw new Error("Invalid protected content");
    const bytes = Uint8Array.from(atob(ciphertext.slice(3)), (character) =>
      character.charCodeAt(0),
    );
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, 12),
        additionalData: encoder.encode(
          JSON.stringify(["v1", orgId, runId, kind]),
        ),
      },
      await key,
      bytes.subarray(12),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  }
  return { encrypt, decrypt };
}
