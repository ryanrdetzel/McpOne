import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseEnv } from "../src/index";

const production = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "a-test-secret-with-at-least-32-characters",
  BETTER_AUTH_URL: "https://mcpone.example.com",
  TRUSTED_ORIGINS: "https://mcpone.example.com",
};

describe("explicit runtime bindings", () => {
  it("parses comma-separated exact origins without changing their identity", () => {
    const env = parseEnv({
      ...production,
      TRUSTED_ORIGINS:
        " https://mcpone.example.com, https://admin.example.com:8443 , ",
    });
    expect(env.TRUSTED_ORIGINS).toEqual([
      "https://mcpone.example.com",
      "https://admin.example.com:8443",
    ]);
  });

  it("accepts explicit origin arrays and HTTP local bindings", () => {
    const env = parseEnv({
      BETTER_AUTH_URL: "http://localhost:8787",
      TRUSTED_ORIGINS: ["http://localhost:8787"],
    });
    expect(env.TRUSTED_ORIGINS).toEqual(["http://localhost:8787"]);
  });

  it.each([
    "*",
    "https://*.example.com",
    "https://mcpone.example.com/",
    "https://mcpone.example.com/path",
    "https://mcpone.example.com?query=1",
    "https://mcpone.example.com#fragment",
    "https://user:password@mcpone.example.com",
    "ftp://mcpone.example.com",
    "not-a-url",
  ])("rejects unsafe trusted origin %s", (origin) => {
    expect(() => parseEnv({ TRUSTED_ORIGINS: origin })).toThrow(ZodError);
  });

  it.each(["ftp://example.com", "javascript:alert(1)", "not-a-url", ""])(
    "rejects non-HTTP(S) auth URL %s with a validation error",
    (url) => {
      expect(() => parseEnv({ ...production, BETTER_AUTH_URL: url })).toThrow(
        ZodError,
      );
    },
  );

  it.each([
    undefined,
    "dev-secret-do-not-ship",
    "short-secret",
    "                                ",
  ])("rejects insecure production secret %s", (secret) => {
    expect(() =>
      parseEnv({ ...production, BETTER_AUTH_SECRET: secret }),
    ).toThrow(ZodError);
  });

  it("requires an explicit production auth URL", () => {
    expect(() =>
      parseEnv({ ...production, BETTER_AUTH_URL: undefined }),
    ).toThrow(ZodError);
  });

  it.each([undefined, "", "https://other.example.com"])(
    "requires production trusted origins including the auth origin: %s",
    (origins) => {
      expect(() =>
        parseEnv({ ...production, TRUSTED_ORIGINS: origins }),
      ).toThrow(ZodError);
    },
  );

  it("rejects non-string binding values instead of coercing them", () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: 123 })).toThrow(ZodError);
    expect(() => parseEnv({ TRUSTED_ORIGINS: [false] })).toThrow(ZodError);
  });
});
