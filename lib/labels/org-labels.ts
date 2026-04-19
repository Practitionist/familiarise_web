/**
 * Shared user-facing labels for Organization + Membership + BillingAccount.
 *
 * Every dashboard badge, form option, review summary, and checkout subtitle
 * that needs a human-readable version of a new-taxonomy enum pulls from
 * here. Centralising avoids the "BUYER" badge inconsistency that happened
 * when labels were defined inline in OrgContextBar vs OrganizationSwitcher
 * vs org-list.
 *
 * Palette conventions:
 *   - Sponsor (buyer-side): blue
 *   - Host (seller-side):   emerald
 *   - Hybrid (both):        purple
 *   - Personal (no org):    zinc
 *
 * Funding-source palette mirrors the financial weight of the mode:
 *   - Personal: zinc   (learner pays own card)
 *   - Wallet:   amber  (pre-funded credit pool)
 *   - Invoice:  orange (postpaid; expects settlement action)
 *   - License:  green  (fully paid, no per-session billing)
 */

import type { FundingSource, MemberRole, MemberStatus } from "@prisma/client";

// ───────────────────────────── Capability ─────────────────────────────

export type CapabilityKind = "SPONSOR" | "HOST" | "HYBRID" | "INERT";

export function deriveCapabilityKind(
  canSponsor: boolean,
  canHost: boolean,
): CapabilityKind {
  if (canSponsor && canHost) return "HYBRID";
  if (canSponsor) return "SPONSOR";
  if (canHost) return "HOST";
  return "INERT";
}

export const CAPABILITY_LABEL: Record<CapabilityKind, string> = {
  SPONSOR: "Sponsor",
  HOST: "Host",
  HYBRID: "Hybrid",
  INERT: "Inactive",
};

export const CAPABILITY_BADGE_CLASS: Record<CapabilityKind, string> = {
  SPONSOR: "bg-blue-100 text-blue-900 border-blue-200",
  HOST: "bg-emerald-100 text-emerald-900 border-emerald-200",
  HYBRID: "bg-purple-100 text-purple-900 border-purple-200",
  INERT: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export const CAPABILITY_DESCRIPTION: Record<CapabilityKind, string> = {
  SPONSOR:
    "Pays for its members' sessions. Has a BillingAccount; does not host consultants.",
  HOST:
    "Hosts consultants who earn through the organization. Has a payout account; does not sponsor anyone.",
  HYBRID:
    "Both sponsors its members and hosts consultants. Runs both money flows independently.",
  INERT:
    "Neither sponsors nor hosts. Typically a transitional state — usually means the org was created but never configured.",
};

// ───────────────────────────── FundingSource ─────────────────────────────

export const FUNDING_SOURCE_LABEL: Record<FundingSource, string> = {
  PERSONAL: "Personal",
  WALLET: "Wallet",
  INVOICE: "Invoice",
  LICENSE: "License",
  PROJECT: "Project",
};

export const FUNDING_SOURCE_TAGLINE: Record<FundingSource, string> = {
  PERSONAL:
    "Members pay at checkout with their own card; the org is tagged for reporting only.",
  WALLET:
    "Org pre-purchases a credit pool. Credits are deducted automatically when members book.",
  INVOICE:
    "Members book freely. One consolidated invoice at month-end; pay within NET terms.",
  LICENSE:
    "Flat-fee enterprise license. Sessions are unmetered for the contract period.",
  PROJECT:
    "Per-engagement fixed-fee or hourly billing. Reserved for v2.",
};

export const FUNDING_SOURCE_BADGE_CLASS: Record<FundingSource, string> = {
  PERSONAL: "bg-zinc-100 text-zinc-700 border-zinc-200",
  WALLET: "bg-amber-100 text-amber-900 border-amber-200",
  INVOICE: "bg-orange-100 text-orange-900 border-orange-200",
  LICENSE: "bg-green-100 text-green-900 border-green-200",
  PROJECT: "bg-slate-100 text-slate-600 border-slate-200",
};

// ───────────────────────────── MemberRole ─────────────────────────────

// UI labels mirror the enum values 1:1 — one vocabulary across code,
// logs, and user-facing copy. Avoids the "enum says MAINTAINER, UI says
// Admin" mismatch that makes support tickets confusing.
export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  OWNER: "Owner",
  MAINTAINER: "Maintainer",
  MANAGER: "Manager",
  EXPERT: "Expert",
  LEARNER: "Learner",
  SUPPORT: "Support",
};

export const MEMBER_ROLE_DESCRIPTION: Record<MemberRole, string> = {
  OWNER: "Full control: billing, members, settings, deletion.",
  MAINTAINER:
    "Members, plans, programs, and settings. No billing or deletion.",
  MANAGER: "Team analytics, seat management, earnings view.",
  EXPERT: "Delivers services on behalf of the organization.",
  LEARNER: "Consumes services through the organization's programs.",
  SUPPORT: "Views support tickets and assists members. No billing.",
};

// ───────────────────────────── MemberStatus ─────────────────────────────

export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  PENDING: "Pending",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  REMOVED: "Removed",
};

export const MEMBER_STATUS_BADGE_CLASS: Record<MemberStatus, string> = {
  PENDING: "bg-amber-100 text-amber-900 border-amber-200",
  ACTIVE: "bg-green-100 text-green-900 border-green-200",
  SUSPENDED: "bg-orange-100 text-orange-900 border-orange-200",
  REMOVED: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

// ───────────────────────────── Zod narrowing schemas ─────────────────────────────
//
// Rather than ad-hoc `typeof v === "string" && arr.includes(v)` checks
// sprinkled through every form, we keep the authoritative subset here as
// Zod enums. Callers import the schema and use `.safeParse` to narrow at
// runtime; the derived TypeScript types come from `z.infer`. One module
// owns the option list + the type + the validator — adding a new value
// updates all three.
//
// Why subsets?
//   - Prisma's full `MemberRole` enum includes CONSULTANT and SUPPORT.
//     Self-service wizards shouldn't let a founder pick those (CONSULTANT
//     needs canHost=true and the apply flow; SUPPORT is an operator role).
//   - Prisma's full `FundingSource` enum includes PROJECT, which is v2
//     (milestone workflow missing). Keeping it out of self-service keeps
//     invalid states unrepresentable.

import { z } from "zod";

export const SelfServiceFundingSourceSchema = z.enum([
  "PERSONAL",
  "WALLET",
  "INVOICE",
  "LICENSE",
]);
export type SelfServiceFundingSource = z.infer<
  typeof SelfServiceFundingSourceSchema
>;
export const SELF_SERVICE_FUNDING_SOURCES =
  SelfServiceFundingSourceSchema.options;

// Self-service onboarding exposes the four non-privileged MemberRoles.
// EXPERT and SUPPORT are assigned elsewhere:
//   EXPERT  requires canHost=true and the application workflow;
//   SUPPORT is an operator role assigned by owners from Settings.
export const SelfServiceMemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "MANAGER",
  "LEARNER",
]);
export type SelfServiceMemberRole = z.infer<typeof SelfServiceMemberRoleSchema>;
export const SELF_SERVICE_MEMBER_ROLES = SelfServiceMemberRoleSchema.options;

/**
 * Narrow an untyped value to a self-service funding source, falling back
 * to PERSONAL if the input is unrecognized. Use at form-hydration +
 * Select `onValueChange` boundaries instead of `as`.
 */
export function narrowFundingSource(
  v: unknown,
  fallback: SelfServiceFundingSource = "PERSONAL",
): SelfServiceFundingSource {
  const parsed = SelfServiceFundingSourceSchema.safeParse(v);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Narrow an untyped value to a self-service member role, falling back to
 * MEMBER if unrecognized.
 */
export function narrowSelfServiceRole(
  v: unknown,
  fallback: SelfServiceMemberRole = "LEARNER",
): SelfServiceMemberRole {
  const parsed = SelfServiceMemberRoleSchema.safeParse(v);
  return parsed.success ? parsed.data : fallback;
}
