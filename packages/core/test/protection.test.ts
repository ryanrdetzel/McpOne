import { expect, it } from "vitest";
import { createPayloadProtection } from "../src/execution/protection";

it("binds protected content to organization, Run and purpose with fresh nonces", async () => {
  const codec = createPayloadProtection(
    "public-development-unit-test-key-never-production",
  );
  const payload = { value: 7, note: "public-sensitive-fixture-marker" };
  const encrypted = await codec.encrypt(
    "org-public",
    "run-public",
    "request",
    payload,
  );
  expect(encrypted).not.toContain(payload.note);
  expect(
    await codec.encrypt("org-public", "run-public", "request", payload),
  ).not.toBe(encrypted);
  expect(
    await codec.decrypt("org-public", "run-public", "request", encrypted),
  ).toEqual(payload);
  await expect(
    codec.decrypt("another-org", "run-public", "request", encrypted),
  ).rejects.toThrow();
  await expect(
    codec.decrypt("org-public", "another-run", "request", encrypted),
  ).rejects.toThrow();
  await expect(
    codec.decrypt("org-public", "run-public", "result", encrypted),
  ).rejects.toThrow();
  const damaged = `${encrypted.slice(0, -8)}AAAAAAAA`;
  await expect(
    codec.decrypt("org-public", "run-public", "request", damaged),
  ).rejects.toThrow();
});
