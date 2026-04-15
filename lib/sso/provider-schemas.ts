/**
 * Zod schemas for SSO provider registration.
 *
 * `callbackUrl` is deliberately absent from `samlConfigSchema`: BetterAuth
 * auto-derives the ACS URL as `{baseURL}/api/auth/sso/saml2/sp/acs/{providerId}`,
 * and accepting a user-typed override silently breaks SAML when the value
 * drifts from BetterAuth's derived URL. The read-only URL shown in the Add
 * Provider dialog is always in sync because both it and BetterAuth derive
 * from the same `providerId`.
 *
 * Extracted from the API route so the shape can be unit-tested and so any
 * future edits to `samlConfigSchema` must touch this single file — which
 * the invariants check in `scripts/verify-sso-invariants.sh` greps for the
 * forbidden `callbackUrl` key.
 */

import { z } from "zod";

export const oidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url(),
  pkce: z.boolean().default(true),
  scopes: z.array(z.string()).optional(),
});

export const samlConfigSchema = z.object({
  issuer: z.string().min(1),
  entryPoint: z.string().url(),
  cert: z.string().min(1),
});

export const createProviderSchema = z.object({
  providerId: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/i, "providerId must be alphanumeric"),
  domain: z.string().trim().min(3).max(255),
  issuer: z.string().trim().min(1).max(500),
  providerType: z.enum(["saml", "oidc"]),
  samlConfig: samlConfigSchema.optional(),
  oidcConfig: oidcConfigSchema.optional(),
});
