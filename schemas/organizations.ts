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
import { OrgOnboardingSchema } from "@/utils/onboarding";
import {
  HostInvitableMemberRoleSchema,
  MemberRoleSchema,
  SelfServiceFundingSourceSchema,
} from "@/lib/labels/org-labels";

// ───────────────────────────── Organization ─────────────────────────────

export const OrganizationSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  canSponsor: z.boolean().optional(),
  canHost: z.boolean().optional(),
});

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
  // TODO(#714): PERSONAL on a sponsor org is reimbursement-only today —
  // member pays from their own card, the org gets a tag for reporting,
  // but there is no member-spend / reimbursement-report dashboard
  // surface yet. The wizard's BillingStep mounts a WIP banner when
  // PERSONAL is selected so operators see the gap.
  fundingSource: SelfServiceFundingSourceSchema.optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  gstStateCode: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  /** First-time owner: completes onboarding in the org-create transaction. */
  onboarding: OrgOnboardingSchema.optional(),
});

// PATCH /api/organizations/[orgId] — fields the dashboard surfaces.
// The wizard's Review step sends branding fields; the Settings page
// adds slug, capability flags, and the standard profile fields. Other
// PATCH fields (gstin, pan, gstStateCode, etc.) flow through their own
// dedicated forms and aren't validated here.
export const PatchOrganizationPayloadSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(80)
    .regex(
      /^[a-z0-9-]+$/,
      "Slug may only contain lowercase letters, digits, and hyphens",
    )
    .optional(),
  description: z.string().max(5000).nullable().optional(),
  industry: z.string().max(120).nullable().optional(),
  website: z.string().url().nullable().optional(),
  billingEmail: z.string().email().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  canSponsor: z.boolean().optional(),
  canHost: z.boolean().optional(),
  isPublic: z.boolean().optional(),
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
  // MSME declaration (#1230) — mirrors the server PATCH schema; feeds the
  // 15/45-day payout-deadline engine.
  msmeStatus: z.enum(["NONE", "MICRO", "SMALL", "MEDIUM"]).optional(),
  msmeWrittenAgreementOnFile: z.boolean().optional(),
});

// POST /api/organizations/[orgId]/rate-cards — 3-way split for host orgs.
// bps values must sum to 10 000 (enforced server-side; duplicated here so
// the wizard catches it before opening the network connection).
export const CreateRateCardPayloadSchema = z
  .object({
    platformBps: z.number().int().min(0).max(10000),
    orgBps: z.number().int().min(0).max(10000),
    consultantBps: z.number().int().min(0).max(10000),
  })
  .refine((v) => v.platformBps + v.orgBps + v.consultantBps === 10000, {
    message: "Revenue split must add up to 100%",
  });

// ───────────────────────────── Members ─────────────────────────────

/** #1527 — the statuses a roster lists; ERASED tombstones never leave the server. */
export const MEMBER_LIST_STATUSES = [
  "ACTIVE",
  "PENDING",
  "SUSPENDED",
  "REMOVED",
] as const;

const MemberStatusSchema = z.enum(MEMBER_LIST_STATUSES);

export const MemberRowSchema = z.object({
  id: z.string(),
  // memberId is the BetterAuth bridge row id — server returns it for
  // legacy callers; the dashboard mostly uses `id` (Membership.id).
  memberId: z.string().optional(),
  role: MemberRoleSchema,
  status: MemberStatusSchema,
  // #729 — payout routing for EXPERT members (SELF / ORGANIZATION). Absent
  // unless the viewer holds `payouts.read` (#1527): never default it, or an
  // edit would write SELF over ORGANIZATION.
  payoutRecipient: z.enum(["SELF", "ORGANIZATION"]).optional(),
  createdAt: z.string(),
  // #1527 — the EXPERT row's secondary line.
  consultantProfile: z
    .object({
      headline: z.string().nullable(),
      publishedRatingOneToOne: z.number().nullable(),
      publishedRatingGroup: z.number().nullable(),
      ratedClientsOneToOne: z.number().int().nonnegative(),
      isVerified: z.boolean(),
    })
    .nullable()
    .optional(),
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  }),
});
export type MemberRow = z.infer<typeof MemberRowSchema>;

/** #902 — shared members page size. The SSR prefetch (lib/data/org-members) and
 *  the client's first query MUST use this same value (and matching queryKey) or
 *  hydration silently misses and the roster re-fetches on mount. Lives here (a
 *  client-safe module, no prisma) so both sides can import it. */
export const ORG_MEMBERS_PER_PAGE = 25;

export const MEMBER_LIST_SORTS = ["name", "role", "joined"] as const;

/** "EXPERT,LEARNER" → ["EXPERT", "LEARNER"]; an empty list is no filter. */
function csvList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const parts = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  }, z.array(item).min(1).max(max).optional());
}

const optionalText = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => v || undefined);

/** GET /api/organizations/[orgId]/members query (#1527). */
export const MembersListQuerySchema = z.object({
  q: optionalText,
  role: csvList(MemberRoleSchema, MemberRoleSchema.options.length),
  // Absent = every listed status; ERASED is not accepted.
  status: csvList(MemberStatusSchema, MEMBER_LIST_STATUSES.length),
  departmentLabel: optionalText,
  sort: z.enum(MEMBER_LIST_SORTS).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(ORG_MEMBERS_PER_PAGE),
});
export type MembersListQuery = z.infer<typeof MembersListQuerySchema>;

/**
 * The Members tab's URL (`useListParams`: `sort=-joined`, status defaulting to
 * Active) → the API query. A bad value falls back to its default rather than
 * failing the whole list. Shared by the SSR prefetch and the client so both
 * build the same query key (#902).
 */
export function membersListQueryFromUrl(
  get: (key: string) => string | null | undefined,
): MembersListQuery {
  const rawSort = get("sort") ?? "";
  const raw: Record<string, string | undefined> = {
    q: get("q") ?? undefined,
    role: get("role") ?? undefined,
    status: get("status") ?? "ACTIVE",
    sort: rawSort.replace(/^-/, "") || undefined,
    dir: rawSort.startsWith("-") ? "desc" : undefined,
    page: get("page") ?? undefined,
  };
  const parsed = MembersListQuerySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  if (bad.has("sort")) bad.add("dir");
  return MembersListQuerySchema.parse({
    ...Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k))),
    ...(bad.has("status") && { status: "ACTIVE" }),
  });
}

export function membersListKey(orgId: string, query: MembersListQuery) {
  return ["org-members", orgId, query] as const;
}

export interface MembersListResult {
  members: MemberRow[];
  total: number;
  /** Per role under the status filter, for the role chips. */
  counts: Partial<Record<MemberRow["role"], number>>;
}

export const MembersListResponseSchema = z.object({
  data: z.array(MemberRowSchema).default([]),
  meta: z
    .object({
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      perPage: z.number().int().positive(),
    })
    .optional(),
  counts: z.record(MemberRoleSchema, z.number().int().nonnegative()).optional(),
});

// PATCH body shared with the edit-member dialog. At least one of role or
// status must be set; the server enforces a `.refine()` on the same
// constraint, so this mirror prevents an empty PATCH from ever leaving
// the client.
export const UpdateMemberPayloadSchema = z
  .object({
    role: MemberRoleSchema.optional(),
    status: MemberStatusSchema.optional(),
    // #729 — payout routing for an EXPERT (SELF → personal account,
    // ORGANIZATION → org absorbs + distributes). Server only honours it on
    // EXPERT members.
    payoutRecipient: z.enum(["SELF", "ORGANIZATION"]).optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.status !== undefined ||
      v.payoutRecipient !== undefined,
    { message: "Provide at least one of role, status, or payout recipient" },
  );

// ───────────────────────────── Invitations ─────────────────────────────

const InvitationStatusSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "CANCELED",
  "EXPIRED",
]);

export const InvitationRowSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  // A MemberRole; kept loose so a future role addition doesn't crash the table.
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
// Mirrors `InviteBodySchema` on the server. EXPERT is only accepted on
// canHost=true orgs; the server narrows back to the self-service subset
// for sponsor-only orgs and rejects with EXPERT_REQUIRES_CANHOST.
export const CreateInvitationPayloadSchema = z.object({
  email: z.string().email(),
  role: HostInvitableMemberRoleSchema,
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

export const CreateInvitationResponseSchema = z.object({
  invitation: InvitationRowSchema,
});

// ───────────────────────────── SSO ─────────────────────────────

export const SsoProviderRowSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  issuer: z.string(),
  // Comma-separated: one provider may cover several verified domains.
  domain: z.string(),
  providerType: z.literal("oidc"),
  // False until platform staff approve the provider; sign-in through it is
  // refused until then.
  domainVerified: z.boolean(),
  // Set by the first SSO sign-in through it by an org OWNER; enforcement
  // needs a proven provider.
  provenAt: z.string().nullable(),
  // Built server-side from BETTER_AUTH_URL, the origin the plugin redirects to.
  callbackUrl: z.string(),
});

export const SsoSettingsResponseSchema = z.object({
  settings: z.object({
    enforceSSO: z.boolean(),
    // JIT auto-join is hard-locked to LEARNER (audit Phase A.1). The
    // server enforces this; the client schema mirrors it so a stale
    // response from a pre-fix server is caught at the parse boundary.
    defaultRoleForAutoJoin: z.literal("LEARNER"),
  }),
  providers: z.array(SsoProviderRowSchema).default([]),
});
export type SsoSettingsResponse = z.infer<typeof SsoSettingsResponseSchema>;

// PATCH /api/organizations/[orgId]/sso — outbound.
export const PatchSsoSettingsPayloadSchema = z.object({
  enforceSSO: z.boolean().optional(),
  // Locked to LEARNER per audit Phase A.1 — client cannot pick the
  // role anymore; if some legacy caller still sends one, the server
  // rejects anything other than LEARNER with 400.
  defaultRoleForAutoJoin: z.literal("LEARNER").optional(),
});

// POST /api/organizations/[orgId]/sso/providers — outbound. SSO is
// OIDC-only; PKCE and scopes are fixed server-side.
const OidcConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url(),
});
// No providerId: the server generates it.
export const CreateSsoProviderPayloadSchema = z.object({
  domains: z.array(z.string().min(1)).min(1),
  issuer: z.string().min(1),
  providerType: z.literal("oidc"),
  oidcConfig: OidcConfigSchema,
});
export type CreateSsoProviderPayload = z.infer<
  typeof CreateSsoProviderPayloadSchema
>;

// PATCH /api/organizations/[orgId]/sso/providers/[providerId] — outbound.
export const UpdateSsoProviderPayloadSchema = z.object({
  clientSecret: z.string().min(1).optional(),
  domains: z.array(z.string().min(1)).min(1).optional(),
});
export type UpdateSsoProviderPayload = z.infer<
  typeof UpdateSsoProviderPayloadSchema
>;

// ───────────────────────────── Programs ─────────────────────────────

export const CoveredPlanTypeSchema = z.enum([
  "CONSULTATION",
  "CLASS",
  "WEBINAR",
  "SUBSCRIPTION",
]);

export const BillingCycleSchema = z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]);
export const OverageBehaviorSchema = z.enum([
  "BLOCK",
  "CHARGE_MEMBER",
  "CHARGE_ORG",
]);
export const ChargeMemberSettlementModeSchema = z.enum([
  "CHECKOUT_COPAY",
  "POST_HOC_LINK",
]);
export const ProgramStatusSchema = z.enum([
  "ACTIVE",
  "PAUSED",
  "EXPIRED",
  "CANCELLED",
]);

export const LicensedSeatConfigSchema = z.object({
  ratePerSeatPaise: z.number().int().min(0),
  cycle: BillingCycleSchema,
  coveredEngagementsPerCycle: z.number().int().min(0).nullable().optional(),
  overageBehavior: OverageBehaviorSchema.optional(),
  chargeMemberSettlementMode: ChargeMemberSettlementModeSchema.optional(),
  priceCapPerEngagementPaise: z.number().int().positive().nullable().optional(),
  overageSurchargeBps: z.number().int().min(0).max(10000).nullable().optional(),
  maxOveragePerCyclePaise: z.number().int().positive().nullable().optional(),
});

export const CreditPoolConfigSchema = z.object({
  cycle: BillingCycleSchema,
  creditBudgetPerCycle: z.number().int().min(1),
  overageBehavior: OverageBehaviorSchema.optional(),
  chargeMemberSettlementMode: ChargeMemberSettlementModeSchema.optional(),
  priceCapPerEngagementPaise: z.number().int().positive().nullable().optional(),
  overageSurchargeBps: z.number().int().min(0).max(10000).nullable().optional(),
  maxOveragePerCyclePaise: z.number().int().positive().nullable().optional(),
});

export const CreateProgramSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("LICENSED_SEAT"),
    contractId: z.string().min(1),
    name: z.string().min(2).max(120),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).default([]),
    allowedCategories: z.array(z.string()).default([]),
    licensedSeatConfig: LicensedSeatConfigSchema,
    forceOverlap: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("CREDIT_POOL"),
    contractId: z.string().min(1),
    name: z.string().min(2).max(120),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).default([]),
    allowedCategories: z.array(z.string()).default([]),
    creditPoolConfig: CreditPoolConfigSchema,
    forceOverlap: z.boolean().default(false),
  }),
]);
export const CreateProgramPayloadSchema = CreateProgramSchema;
export type CreateProgramPayload = z.infer<typeof CreateProgramSchema>;

export const UpdateProgramSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    status: ProgramStatusSchema.optional(),
    archived: z.boolean().optional(),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).optional(),
    allowedCategories: z.array(z.string()).optional(),
    ratePerSeatPaise: z.number().int().min(0).optional(),
    coveredEngagementsPerCycle: z.number().int().min(1).nullable().optional(),
    creditBudgetPerCycle: z.number().int().min(1).optional(),
    overageBehavior: OverageBehaviorSchema.optional(),
    chargeMemberSettlementMode: ChargeMemberSettlementModeSchema.optional(),
    overageSurchargeBps: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .nullable()
      .optional(),
    priceCapPerEngagementPaise: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional(),
    maxOveragePerCyclePaise: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });
export const UpdateProgramPayloadSchema = UpdateProgramSchema;
export type UpdateProgramPayload = z.infer<typeof UpdateProgramSchema>;
