import { ControlError } from "../execution/service";

export type CredentialPurpose = "credential" | "oauth_intent";
/** Separate purpose derivations leave the M1 payload-v1 format untouched. */
export function createCredentialProtection(secret: string) {
  if (!secret)
    throw new Error("Credential protection requires a configured secret");
  const encoder = new TextEncoder();
  const keys = new Map<CredentialPurpose, Promise<CryptoKey>>();
  function key(purpose: CredentialPurpose) {
    let value = keys.get(purpose);
    if (!value) {
      value = crypto.subtle
        .digest(
          "SHA-256",
          encoder.encode(`mcpone/control/${purpose}/v2:${secret}`),
        )
        .then((bytes) =>
          crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
            "encrypt",
            "decrypt",
          ]),
        );
      keys.set(purpose, value);
    }
    return value;
  }
  function aad(
    orgId: string,
    id: string,
    version: number,
    purpose: CredentialPurpose,
  ) {
    return encoder.encode(JSON.stringify(["v2", orgId, id, version, purpose]));
  }
  return {
    async encrypt(
      orgId: string,
      id: string,
      version: number,
      purpose: CredentialPurpose,
      value: unknown,
    ): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad(orgId, id, version, purpose),
          },
          await key(purpose),
          encoder.encode(JSON.stringify(value)),
        ),
      );
      const packed = new Uint8Array(iv.length + encrypted.length);
      packed.set(iv);
      packed.set(encrypted, iv.length);
      let binary = "";
      for (let start = 0; start < packed.length; start += 8192)
        binary += String.fromCharCode(...packed.subarray(start, start + 8192));
      return `v2.${btoa(binary)}`;
    },
    async decrypt<T>(
      orgId: string,
      id: string,
      version: number,
      purpose: CredentialPurpose,
      ciphertext: string,
    ): Promise<T> {
      try {
        if (!ciphertext.startsWith("v2.") || ciphertext.length > 262144)
          throw new Error();
        const packed = Uint8Array.from(atob(ciphertext.slice(3)), (c) =>
          c.charCodeAt(0),
        );
        if (packed.length < 29) throw new Error();
        const plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: packed.subarray(0, 12),
            additionalData: aad(orgId, id, version, purpose),
          },
          await key(purpose),
          packed.subarray(12),
        );
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plain),
        ) as T;
      } catch {
        throw new ControlError(
          "credential_unavailable",
          "Reconnect or rotate this Account credential.",
          409,
        );
      }
    },
  };
}
