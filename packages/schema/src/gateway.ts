import { z } from "zod";
import { PolicyDecision, PolicyPattern } from "./execution";
import { IntegrationSlug, ProfileView, Source } from "./integrations";

export const GatewayCreateProfileInput = z
  .object({ label: z.string().trim().min(1).max(100) })
  .strict();
export const GatewayCreateConnectionInput = z
  .object({
    slug: IntegrationSlug,
    displayName: z.string().trim().min(1).max(100),
    endpoint: z
      .string()
      .max(8192)
      .refine((endpoint) => {
        if (
          !Source.safeParse({
            kind: "remote_mcp",
            endpoint,
            namespace: "gateway",
            nameMapping: {},
          }).success
        )
          return false;
        const url = new URL(endpoint);
        return (
          url.href === endpoint &&
          !/%(?:2f|5c|00)/i.test(url.pathname) &&
          !/%(?![a-f0-9]{2})/i.test(url.pathname)
        );
      }, "Canonical HTTPS endpoint required"),
    bearerToken: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict();
export const GatewayConnection = z
  .object({
    integrationId: z.string().uuid(),
    slug: IntegrationSlug,
    displayName: z.string(),
    enabled: z.boolean(),
    currentRevisionId: z.string().uuid().nullable(),
    endpoint: z.string(),
    authentication: z.enum(["none", "bearer"]),
    draftRevisionId: z.string().uuid().nullable(),
  })
  .strict();
export const GatewayProfile = ProfileView.extend({
  policies: z.array(
    z.object({ pattern: PolicyPattern, decision: PolicyDecision }).strict(),
  ),
  grants: z.array(
    z
      .object({
        grantId: z.string().uuid(),
        label: z.string(),
        expiresAt: z.string().datetime().nullable(),
        revoked: z.boolean(),
      })
      .strict(),
  ),
}).strict();
export const GatewayState = z
  .object({
    profiles: z.array(GatewayProfile),
    connections: z.array(GatewayConnection),
  })
  .strict();
export type GatewayState = z.infer<typeof GatewayState>;
export type GatewayCreateProfileInput = z.infer<
  typeof GatewayCreateProfileInput
>;
export type GatewayCreateConnectionInput = z.infer<
  typeof GatewayCreateConnectionInput
>;
