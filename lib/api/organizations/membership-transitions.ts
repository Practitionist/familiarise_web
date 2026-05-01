/**
 * Computes the role-driven side effects for a Membership row in a single
 * place: which profile FKs to hydrate, which to clear, and what the
 * default `payoutRecipient` should be.
 *
 * Before this helper, four call sites (POST /members, PATCH
 * /members/[memberId], invitations/accept, SSO auto-join in
 * `lib/auth.ts`) each had their own inline branching for profile FK
 * hydration. PATCH only touched role/status/departmentLabel — so a
 * MANAGER → LEARNER transition left `consulteeProfileId` null and
 * `/my-program` joined nothing. SSO auto-join only hydrated the
 * consultee side; an EXPERT default-role org left
 * `consultantProfileId` null forever.
 *
 * Behavior:
 *   - LEARNER → ensure ConsulteeProfile (lazy-create if missing); clear
 *     `consultantProfileId`; default `payoutRecipient = SELF`.
 *   - EXPERT  → ensure ConsultantProfile (lazy-create with the "General"
 *     placeholder domain + WEEKLY schedule, mirroring the existing
 *     invitation-accept seed); clear `consulteeProfileId`; default
 *     `payoutRecipient = SELF`.
 *   - OWNER / MAINTAINER / MANAGER / SUPPORT → operator roles do not
 *     consume or provide; clear both profile FKs; keep
 *     `payoutRecipient = SELF`.
 *
 * Callers pass the enclosing Prisma transaction. The helper does its
 * profile-side work in the same tx so a failure rolls everything back.
 *
 * The LEARNER↔EXPERT block lives in `lib/enterprise/role-transitions.ts`
 * (`isBlockedRoleTransition`) and is enforced at the route layer — this
 * helper does not re-implement it. By the time the helper runs, the
 * transition is already known to be allowed.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";

export type PrismaLike = PrismaClient | Prisma.TransactionClient;

export type RoleEffectInput = {
  userId: string;
  role:
    | "OWNER"
    | "MAINTAINER"
    | "MANAGER"
    | "EXPERT"
    | "LEARNER"
    | "SUPPORT";
};

export type RoleEffectResult = {
  consulteeProfileId: string | null;
  consultantProfileId: string | null;
  payoutRecipient: "SELF" | "ORGANIZATION";
};

/**
 * Returns the consultee/consultant FK values + payoutRecipient default
 * for the target role. For LEARNER and EXPERT, lazy-creates the matching
 * profile when the user does not already have one.
 *
 * The caller is responsible for spreading the returned fields into the
 * `Membership` create/update payload.
 */
export async function applyMembershipRoleEffects(
  tx: PrismaLike,
  input: RoleEffectInput,
): Promise<RoleEffectResult> {
  const { userId, role } = input;

  if (role === "LEARNER") {
    const consulteeProfileId = await ensureConsulteeProfile(tx, userId);
    return {
      consulteeProfileId,
      consultantProfileId: null,
      payoutRecipient: "SELF",
    };
  }

  if (role === "EXPERT") {
    const consultantProfileId = await ensureConsultantProfile(tx, userId);
    return {
      consulteeProfileId: null,
      consultantProfileId,
      payoutRecipient: "SELF",
    };
  }

  // OWNER / MAINTAINER / MANAGER / SUPPORT — operator roles have no
  // consumer or provider profile linkage. Any previously-hydrated FKs
  // are cleared so downstream joins (`/my-program`, `/my-arrangement`,
  // checkout profile resolution) don't pick up stale rows.
  return {
    consulteeProfileId: null,
    consultantProfileId: null,
    payoutRecipient: "SELF",
  };
}

/**
 * Lazy-create a `ConsultantProfile` for the user. Idempotent: if
 * `user.consultantProfileId` is already set, returns it without
 * writing.
 *
 * Mirrors the seed logic in
 * `app/api/organizations/invitations/accept/route.ts:234-272`. New rows
 * use the "General" placeholder domain + WEEKLY schedule;
 * `verificationStatus` defaults to PENDING_VERIFICATION via the schema
 * default, which keeps the profile hidden from `/explore/experts`
 * until a platform admin reviews.
 */
async function ensureConsultantProfile(
  tx: PrismaLike,
  userId: string,
): Promise<string> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });
  if (user?.consultantProfileId) return user.consultantProfileId;

  const placeholderDomain = await tx.domain.upsert({
    where: { name: "General" },
    create: { name: "General" },
    update: {},
    select: { id: true },
  });
  const created = await tx.consultantProfile.create({
    data: {
      userId,
      domainId: placeholderDomain.id,
      scheduleType: "WEEKLY",
    },
    select: { id: true },
  });
  await tx.user.updateMany({
    where: { id: userId, consultantProfileId: null },
    data: { consultantProfileId: created.id },
  });
  return created.id;
}

/**
 * Recompute `ConsultantProfile.isIndependent` from current membership
 * state. Call this AFTER any membership mutation that touches the
 * consultant's EXPERT memberships:
 *   - POST /api/organizations/[orgId]/members (create EXPERT)
 *   - PATCH /api/organizations/[orgId]/members/[memberId] (role / status change)
 *   - DELETE /api/organizations/[orgId]/members/[memberId] (soft-delete)
 *   - invitation accept (create EXPERT via accept flow)
 *   - SSO auto-join (create EXPERT via custom session hook)
 *
 * Rule: `isIndependent = true` iff the consultant has ZERO active EXPERT
 * memberships at HOST-capable orgs (`organization.canHost = true`). The
 * flag drives the "Hosted by X" badge on the marketplace explore page.
 *
 * Idempotent: safe to call multiple times. Only HOST-capable orgs count
 * — a sponsor-only org doesn't host the expert in the marketplace sense.
 *
 * Backfill: `prisma/scripts/backfill-isindependent.ts` walks every
 * ConsultantProfile and runs this once.
 */
export async function recomputeConsultantIsIndependent(
  tx: PrismaLike,
  consultantProfileId: string,
): Promise<void> {
  const activeExpertCount = await tx.membership.count({
    where: {
      consultantProfileId,
      role: "EXPERT",
      status: "ACTIVE",
      organization: { canHost: true },
    },
  });
  await tx.consultantProfile.update({
    where: { id: consultantProfileId },
    data: { isIndependent: activeExpertCount === 0 },
  });
}
