/**
 * Zod schemas for SSO provider registration and in-place updates. SSO is
 * OIDC-only; PKCE and the `openid email profile` scopes are fixed server-side.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AUTH_PROVIDERS } from "@/lib/auth-providers";

export const SSO_SCOPES = ["openid", "email", "profile"] as const;

export const oidcConfigSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url(),
});

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Enter a bare domain such as acme.com");

/** One provider may cover several of the org's verified domains. */
export const providerDomainsSchema = z.array(domainSchema).min(1).max(20);

/**
 * Provider ids a tenant may not claim, because the id is the global URL slug
 * of the SSO callback: social button ids, BetterAuth's `credential`, the
 * retired `facebook` and the plugin's `sso` namespace. The DB CHECK
 * `sso_provider_id_not_reserved` refuses the same set.
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "credential",
  "sso",
  "facebook",
  ...AUTH_PROVIDERS.map((provider) => provider.id),
]);

export function isReservedProviderId(providerId: string): boolean {
  return RESERVED_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/** An unguessable `oidc-<16 hex>` slug, outside every reserved id. */
export function generateProviderId(): string {
  return `oidc-${randomBytes(8).toString("hex")}`;
}

export const createProviderSchema = z.object({
  domains: providerDomainsSchema,
  issuer: z.string().trim().min(1).max(500),
  providerType: z.literal("oidc"),
  oidcConfig: oidcConfigSchema,
});

/** PATCH: rotate the client secret and/or change the covered domains in place. */
export const updateProviderSchema = z
  .object({
    clientSecret: z.string().min(1).optional(),
    domains: providerDomainsSchema.optional(),
  })
  .refine((v) => v.clientSecret !== undefined || v.domains !== undefined, {
    message: "Send clientSecret, domains or both",
  });
