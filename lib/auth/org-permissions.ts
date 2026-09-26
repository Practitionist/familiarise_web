import type { MemberRole } from "@prisma/client";

/**
 * Org-dashboard permission matrix — the single source of truth for which
 * MemberRole can access which surface. The sidebar (visibility), the page
 * guards (useRequireOrgAccess), and the API routes (requireOrgAccess) all
 * consume THIS map, so a surface can no longer drift into "tab shown, page
 * redirects, API 403s" states (the 2026-07 role audit found nine of those).
 *
 * Why a matrix instead of the rank ladder: privilege here is not
 * one-dimensional. The org has an operations track (MANAGER, SUPPORT), a
 * finance track (BILLING_ADMIN), and member roles (EXPERT, LEARNER) —
 * BILLING_ADMIN outranks MANAGER numerically (70 > 60) yet must see LESS
 * operationally ("operator-blind"), and SUPPORT (30) sees MORE than EXPERT
 * (40) on operations surfaces. Rank comparisons (isAtLeastRole) remain
 * correct only for genuine hierarchy (OWNER > MAINTAINER > MANAGER
 * management chains) — surface access lives here.
 *
 * Capability gates (canSponsor / canHost / requiresPO / fundingSource) are
 * deliberately NOT part of the matrix — they describe the org's shape, not
 * the member's role, and stay as separate structural checks combined with
 * the matrix at each consumer.
 */

export type OrgSurface =
  // People & governance
  | "members.read"
  | "members.manage"
  | "invitations.manage"
  | "learners.read"
  | "experts.read"
  // Floor for the Audit page/API = holds either category grant below; rows
  // are then filtered per grant (#1527 audit split).
  | "audit.read"
  | "audit.read.ops"
  | "audit.read.money"
  // Home activity feed — audit rows, row-filtered like the Audit page.
  | "activity.read"
  | "consent.read"
  | "consent.manage"
  | "settings.manage"
  // Domains & SSO / directory-sync reads — never secrets (#1527).
  | "identity.read"
  // Org chat roster + call metadata compliance reads (Stream).
  | "messaging.read"
  // Commerce (sponsor-side; combine with canSponsor at the consumer)
  | "contracts.read"
  | "contracts.manage"
  // Host-side: authoring the org's OWN bookable offerings. Distinct from
  // programs.manage, which is the sponsor's entitlement CRUD — combine with
  // canHost at the consumer.
  | "catalog.manage"
  | "programs.read"
  | "programs.manage"
  | "purchaseOrders.read"
  | "purchaseOrders.manage"
  // Finance
  | "billing.read"
  | "billing.manage"
  | "payouts.read"
  | "payouts.manage"
  | "reimbursements.read"
  | "disputes.read"
  | "integrations.manage"
  // Operations (org-scoped appointments, trials, documents,
  // recordings, analytics — one read grant for the whole group, incl. the
  // L1/L2 SUPPORT carve-out)
  | "operations.read"
  | "quality.read"
  // Member-facing home surfaces (exact-role, capability-gated in the layout)
  | "myProgram.read"
  | "myArrangement.read";

const roles = (...list: MemberRole[]): ReadonlySet<MemberRole> =>
  new Set<MemberRole>(list);

// Named tiers so the matrix reads as policy, not repetition.
const GOVERNANCE = roles("OWNER", "MAINTAINER");
const OPERATORS = roles("OWNER", "MAINTAINER", "MANAGER");
const OPERATIONS_READERS = roles("OWNER", "MAINTAINER", "MANAGER", "SUPPORT");
const FINANCE_READERS = roles(
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
);
const FINANCE_MUTATORS = roles("OWNER", "BILLING_ADMIN");
const AUDIT_OPS_READERS = OPERATIONS_READERS;
const AUDIT_MONEY_READERS = roles("OWNER", "MAINTAINER", "BILLING_ADMIN");

export const ORG_PERMISSIONS: Record<OrgSurface, ReadonlySet<MemberRole>> = {
  // People & governance — BILLING_ADMIN is operator-blind by design.
  "members.read": OPERATIONS_READERS,
  "members.manage": GOVERNANCE,
  "invitations.manage": GOVERNANCE,
  "learners.read": OPERATORS,
  "experts.read": OPERATORS,
  // #1527 — split by category so SUPPORT reads people/ops history without a
  // single money figure, and BILLING_ADMIN reads the money trail it owns.
  "audit.read": new Set([...AUDIT_OPS_READERS, ...AUDIT_MONEY_READERS]),
  "audit.read.ops": AUDIT_OPS_READERS,
  "audit.read.money": AUDIT_MONEY_READERS,
  // #1527 — was a MANAGER rank floor, which admitted BILLING_ADMIN (rank 70).
  "activity.read": OPERATORS,
  "consent.read": OPERATORS,
  "consent.manage": OPERATORS,
  "settings.manage": GOVERNANCE,
  // #1527 — was a MANAGER rank floor; MAINTAINER reads status, OWNER keeps
  // every write and secret at the route.
  "identity.read": GOVERNANCE,
  // #1527 — was a MANAGER rank floor, which admitted BILLING_ADMIN.
  "messaging.read": OPERATORS,

  // Commerce — contract terms and program design are org-structural
  // decisions (spec: MAINTAINER floor); POs are day-to-day.
  "contracts.read": GOVERNANCE,
  "contracts.manage": roles("OWNER"),
  // OPERATORS rather than GOVERNANCE: publishing an offering is day-to-day
  // delivery work, not an org-structural decision like a contract or a
  // sponsorship program, so MANAGER holds it. EXPERT deliberately does NOT —
  // an org-owned plan commits the ORG's revenue and payout obligation, so it
  // needs an operator in the loop. An EXPERT is named as the deliverer instead.
  "catalog.manage": OPERATORS,
  // #1527 — the org-wide seat roster + utilisation. Everyone else reads only
  // their own assignment, without spend.
  "programs.read": roles("OWNER", "MAINTAINER", "BILLING_ADMIN", "MANAGER"),
  "programs.manage": GOVERNANCE,
  "purchaseOrders.read": FINANCE_READERS,
  "purchaseOrders.manage": FINANCE_MUTATORS,

  // Finance — MANAGER reads, mutations stay with OWNER/BILLING_ADMIN
  // (preserves the requireOrgBillingAdminOrOwner disjunction).
  "billing.read": FINANCE_READERS,
  "billing.manage": FINANCE_MUTATORS,
  "payouts.read": FINANCE_READERS,
  "payouts.manage": FINANCE_MUTATORS,
  "reimbursements.read": FINANCE_READERS,
  "disputes.read": FINANCE_READERS,
  // #1527 §17b — webhook create/edit/redeliver are
  // requireOrgBillingAdminOrOwner; rotate/delete tighten to OWNER at the
  // route. Data exports ride billing.manage.
  "integrations.manage": FINANCE_MUTATORS,

  // Operations — includes the SUPPORT carve-out (L1/L2 triage reads).
  "operations.read": OPERATIONS_READERS,

  // #1300 — the quality signal over the organisation's own sessions. Its own key
  // rather than riding `operations.read`, which is the grant that opens the
  // org-wide appointments feed, the recordings list and the documents list. Those
  // are spend-and-utilisation surfaces; this one is aggregated satisfaction
  // drawn from a member's private rating of a named colleague-facing session, and
  // ADR 20 classifies the underlying rating as CONTENT. Sharing one grant between
  // them means the day somebody widens operations.read for an unrelated reason,
  // they widen this too without noticing.
  //
  // Same roles today. The point is that they can now diverge without a rename.
  "quality.read": OPERATIONS_READERS,

  // Member-facing surfaces.
  "myProgram.read": roles("LEARNER"),
  "myArrangement.read": roles("EXPERT"),
};

export function hasOrgPermission(
  role: MemberRole,
  surface: OrgSurface,
): boolean {
  return ORG_PERMISSIONS[surface].has(role);
}

/** Any-of form for surfaces two grants open (e.g. Settings GET, #1527). */
export function hasAnyOrgPermission(
  role: MemberRole,
  surfaces: OrgSurface | readonly OrgSurface[],
): boolean {
  const list: readonly OrgSurface[] =
    typeof surfaces === "string" ? [surfaces] : surfaces;
  return list.some((surface) => ORG_PERMISSIONS[surface].has(role));
}
