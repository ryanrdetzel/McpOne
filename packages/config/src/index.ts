import { z } from "zod";

/** Ships in the repo, so it is a public value: production must bind a real one. */
const DEV_AUTH_SECRET = "dev-secret-do-not-ship";

/**
 * Parse each Worker's explicit bindings; this module never reads process globals.
 * Deployment origins are literal HTTP(S) origins, not Better Auth wildcard rules.
 */
const HttpUrl = z.url({ protocol: /^https?$/ });
const TrustedOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      !url.hostname.includes("*")
    );
  } catch {
    return false;
  }
}, "Trusted origins must be exact HTTP(S) origins without paths, credentials, query strings, or wildcards");

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    RELEASE: z.string().default("dev"),
    APP_SLUG: z.string().min(1).default("mcpone"),
    BETTER_AUTH_SECRET: z.string().min(1).default(DEV_AUTH_SECRET),
    BETTER_AUTH_URL: HttpUrl.optional(),
    TRUSTED_ORIGINS: z
      .union([
        z.string().transform((value) =>
          value
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
        ),
        z.array(z.string()),
      ])
      .prefault("")
      .pipe(z.array(TrustedOrigin)),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== "production") return;

    if (
      value.BETTER_AUTH_SECRET === DEV_AUTH_SECRET ||
      value.BETTER_AUTH_SECRET.trim().length < 32
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_SECRET"],
        message:
          "Production requires a non-default BETTER_AUTH_SECRET of at least 32 characters",
      });
    }
    if (!value.BETTER_AUTH_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "BETTER_AUTH_URL must be explicitly supplied in production",
      });
    }
    let authOrigin: string | undefined;
    if (value.BETTER_AUTH_URL) {
      try {
        authOrigin = new URL(value.BETTER_AUTH_URL).origin;
      } catch {
        // HttpUrl already reports the malformed binding as a validation issue.
        return;
      }
    }
    if (
      value.TRUSTED_ORIGINS.length === 0 ||
      (authOrigin && !value.TRUSTED_ORIGINS.includes(authOrigin))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["TRUSTED_ORIGINS"],
        message:
          "Production requires explicit trusted origins including the BETTER_AUTH_URL origin",
      });
    }
  })
  .transform((value) => ({
    ...value,
    BETTER_AUTH_URL: value.BETTER_AUTH_URL ?? "http://localhost:3000",
  }));

export function parseEnv(bindings: Record<string, unknown>): Env {
  return EnvSchema.parse(bindings);
}
export type Env = z.infer<typeof EnvSchema>;
