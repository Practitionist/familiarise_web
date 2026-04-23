// schemas/organizations.ts
//
// Zod schemas for the `/api/organizations/**` route family — both
// outbound payloads (the dashboard sends to the server) and inbound
// responses (the server sends back). Mirrors what the route handlers
// declare with `z.object(...)` so a server-side change without a
// client-side update fails at parse time, not at render time.
//
// Convention: only put schemas here that are reused across two or more
// call sites. Anything truly one-off (e.g. a wizard step's local form
// shape) lives at the top of the consuming file under
// `components/organization/create-wizard/schemas.ts`.

import { z } from "zod";
import {
  MemberRoleSchema,
  SelfServiceFundingSourceSchema,
  SelfServiceMemberRoleSchema,
} from "@/lib/labels/org-labels";

// ───────────────────────────── Organization ─────────────────────────────

export const OrganizationSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  canSponsor: z.boolean().optional(),
  canHost: z.boolean().optional(),
});
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;

export const CreateOrganizationResponseSchema = z.object({
  organization: OrganizationSummarySchema,
});

// Outbound payload for POST /api/organizations.
// Mirror the server's `CreateBodySchema` (app/api/organizations/route.ts)
// but only enforce the fields the wizard touches; the server keeps full
// authority on defaults (currency, dataResidencyRegion, requiresPO).
export const CreateOrganizationPayloadSchema = z.object({
  name: z.string().trim().min(2).max(200),
  billingEmail: z.string().email(),
  canSponsor: z.boolean(),
  canHost: z.boolean(),
  description: z.string().max(5000).optional(),
  industry: z.string().max(120).optional(),
  sizeBucket: z.string().optional(),
  website: z.string().url().optional(),
  fundingSource: SelfServiceFundingSourceSchema.optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
});
export type CreateOrganizationPayload = z.infer<
  typeof CreateOrganizationPayloadSchema
>;

// PATCH /api/organizations/[orgId] — branding + rate-card subset used by
// the wizard's review step. Other PATCH fields (gstin, pan, etc.) live
// behind a different settings UX and aren't validated here.
export const PatchOrganizationPayloadSchema = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
    .nullable()
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
    .nullable()
    .optional(),
  platformBps: z.number().int().min(0).max(10000).optional(),
  orgBps: z.number().int().min(0).max(10000).optional(),
  consultantBps: z.number().int().min(0).max(10000).optional(),
});
export type PatchOrganizationPayload = z.infer<
  typeof PatchOrganizationPayloadSchema
>;

// ───────────────────────────── Members ─────────────────────────────

const MemberStatusSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "REMOVED",
]);

export const MemberRowSchema = z.object({
  id: z.string(),
  // memberId is the BetterAuth bridge row id — server returns it for
  // legacy callers; the dashboard mostly uses `id` (Membership.id).
  memberId: z.string().optional(),
  role: MemberRoleSchema,
  status: MemberStatusSchema,
  createdAt: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  }),
});
export type MemberRow = z.infer<typeof MemberRowSchema>;

export const MembersListResponseSchema = z.object({
  data: z.array(MemberRowSchema).default([]),
  meta: z
    .object({
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      perPage: z.number().int().positive(),
    })
    .optional(),
});

// POST /api/organizations/[orgId]/members
// Direct-add a member by email (dashboard path) OR userId (SSO /
// admin tooling). The server accepts either identifier, resolves
// email → userId internally, and returns 404 USER_NOT_FOUND when the
// account doesn't exist. The dashboard always sends email; userId is
// reserved for programmatic callers (SSO provisioning, admin scripts).
export const AddMemberPayloadSchema = z.object({
  email: z.string().email(),
  role: SelfServiceMemberRoleSchema,
});
export type AddMemberPayload = z.infer<typeof AddMemberPayloadSchema>;

// PATCH body shared with the edit-member dialog. At least one of role or
// status must be set; the server enforces a `.refine()` on the same
// constraint, so this mirror prevents an empty PATCH from ever leaving
// the client.
export const UpdateMemberPayloadSchema = z
  .object({
    role: MemberRoleSchema.optional(),
    status: MemberStatusSchema.optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: "Provide at least one of role or status to update",
  });
export type UpdateMemberPayload = z.infer<typeof UpdateMemberPayloadSchema>;

// ───────────────────────────── Invitations ─────────────────────────────

// Invitation.status comes from BetterAuth's bridge table and is stored
// as a free-form lowercase string. We accept the canonical four states
// and gracefully tolerate anything else by relaxing the field — that
// avoids a parse-time crash if BetterAuth introduces a new state.
const InvitationStatusSchema = z
  .union([
    z.enum(["pending", "accepted", "rejected", "expired", "canceled", "revoked"]),
    z.string(),
  ])
  .transform((v) => v as string);

export const InvitationRowSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  // `role` is stored on the BetterAuth invite row as a string; we narrow
  // to MemberRole at the UI level for label lookup, but accept any string
  // so a future role addition doesn't crash the table.
  role: z.string(),
  status: InvitationStatusSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  inviterId: z.string().nullable(),
});
export type InvitationRow = z.infer<typeof InvitationRowSchema>;

export const InvitationsListResponseSchema = z.object({
  data: z.array(InvitationRowSchema).default([]),
});

// POST /api/organizations/[orgId]/invitations — outbound.
// Mirrors `InviteBodySchema` on the server.
export const CreateInvitationPayloadSchema = z.object({
  email: z.string().email(),
  role: SelfServiceMemberRoleSchema,
  expiresInDays: z.number().int().min(1).max(30).optional(),
});
export type CreateInvitationPayload = z.infer<
  typeof CreateInvitationPayloadSchema
>;

export const CreateInvitationResponseSchema = z.object({
  invitation: InvitationRowSchema,
});

// ───────────────────────────── SSO ─────────────────────────────

export const SsoProviderRowSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  issuer: z.string(),
  domain: z.string(),
  // Server occasionally hands back null when the provider was registered
  // before the type column existed; tolerate it so the table renders.
  providerType: z.enum(["saml", "oidc"]).nullable(),
});
export type SsoProviderRow = z.infer<typeof SsoProviderRowSchema>;

export const SsoSettingsResponseSchema = z.object({
  settings: z.object({
    allowedEmailDomains: z.array(z.string()).default([]),
    enforceSSO: z.boolean(),
    defaultRoleForAutoJoin: MemberRoleSchema,
  }),
  providers: z.array(SsoProviderRowSchema).default([]),
});
export type SsoSettingsResponse = z.infer<typeof SsoSettingsResponseSchema>;

// PATCH /api/organizations/[orgId]/sso — outbound.
// Domain validation lives in `lib/enterprise/validators#DomainSchema`;
// we keep the array element loose here because the server is the
// authoritative validator and we already trim+filter at the UI level.
export const PatchSsoSettingsPayloadSchema = z.object({
  allowedEmailDomains: z.array(z.string()).optional(),
  enforceSSO: z.boolean().optional(),
  defaultRoleForAutoJoin: MemberRoleSchema.optional(),
});
export type PatchSsoSettingsPayload = z.infer<
  typeof PatchSsoSettingsPayloadSchema
>;

// POST /api/organizations/[orgId]/sso/providers — outbound.
// Discriminated union on `providerType` so the SAML branch must include
// `samlConfig` and the OIDC branch must include `oidcConfig`. This catches
// a class of UI bugs at the call site (e.g. flipping the type radio
// without re-validating the matching config).
const SamlConfigSchema = z.object({
  issuer: z.string().min(1),
  entryPoint: z.string().url(),
  cert: z.string().min(1),
});
const OidcConfigSchema = z.object({
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url(),
  pkce: z.boolean(),
});
export const CreateSsoProviderPayloadSchema = z.discriminatedUnion(
  "providerType",
  [
    z.object({
      providerId: z.string().min(1),
      domain: z.string().min(1),
      issuer: z.string().min(1),
      providerType: z.literal("saml"),
      samlConfig: SamlConfigSchema,
    }),
    z.object({
      providerId: z.string().min(1),
      domain: z.string().min(1),
      issuer: z.string().min(1),
      providerType: z.literal("oidc"),
      oidcConfig: OidcConfigSchema,
    }),
  ],
);
export type CreateSsoProviderPayload = z.infer<
  typeof CreateSsoProviderPayloadSchema
>;
