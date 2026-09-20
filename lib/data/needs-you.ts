import prisma from "@/lib/prisma";
import type { AppointmentStatus, Prisma } from "@prisma/client";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import { readPayoutRequirements } from "@/lib/data/consultant-payout-setup";
import type { PayoutRequirements } from "@/lib/payments/payouts/payout-requirements";

/**
 * Cross-context "needs you" roll-up for a consultant.
 *
 * ADR 19 splits the dashboards by the org-ness of the underlying work, and
 * accepts as a known cost that "a consultant who works through an organization
 * now visits two dashboards". It also states the only sanctioned remedy: a
 * cross-context summary "would have to be built as a derived read rather than
 * by re-merging the views". This is that derived read.
 *
 * It deliberately returns COUNTS AND LINKS ONLY. It does not return rows, and
 * nothing renders from it in place — every item routes the user into the
 * dashboard that owns the work, which is what keeps each number authoritative
 * in exactly one place.
 */

export interface NeedsYouContext {
  /** Null for the personal B2C context. */
  organizationId: string | null;
  label: string;
  /** Booking requests waiting for this consultant to allocate slots. */
  pendingRequests: number;
  /** Where to send someone who clicks through. */
  href: string;
}

export interface NeedsYouSummary {
  contexts: NeedsYouContext[];
  total: number;
}

/**
 * #674 defect 13 — the org dimension comes from the shared projector, so
 * "what personal means" is defined once (lib/api/scope/parse.ts) instead of
 * being re-typed as a literal at each call site. The extra `appointment: null`
 * arm below is this surface's own business rule, not a scope rule: a request
 * has no appointment until it is allocated, and an unallocated request is by
 * definition not org-funded.
 *
 * #1345 — exported because the consultant Home badge counts the same cohort a
 * few inches above NeedsYou, and re-typing the predicate there let the two
 * numbers drift into different scopes.
 */
export function pendingConsultationWhere(
  consultantProfileId: string,
  scope: Scope,
): Prisma.ConsultationWhereInput {
  return consultationRequestWhere(consultantProfileId, scope, "PENDING");
}

/** The pending predicate at any status; Home's "Awaiting payment" row reads
 * it at APPROVED_PENDING_PAYMENT so the two cohorts share one scope. #1703 */
export function consultationRequestWhere(
  consultantProfileId: string,
  scope: Scope,
  status: AppointmentStatus,
): Prisma.ConsultationWhereInput {
  const orgWhere = scopeToWhereOrgId(scope);
  return {
    status,
    consultationPlan: { consultantProfileId },
    ...(scope.kind === "personal"
      ? { OR: [{ appointment: null }, { appointment: orgWhere }] }
      : { appointment: orgWhere }),
  };
}

// #1638 made Subscription.appointment singular; the return is typed so the
// next relation rename fails tsc instead of the dashboard route (FAMILIARISE_WEB-3Y).
export function pendingSubscriptionWhere(
  consultantProfileId: string,
  scope: Scope,
): Prisma.SubscriptionWhereInput {
  return subscriptionRequestWhere(consultantProfileId, scope, "PENDING");
}

export function subscriptionRequestWhere(
  consultantProfileId: string,
  scope: Scope,
  status: AppointmentStatus,
): Prisma.SubscriptionWhereInput {
  const orgWhere = scopeToWhereOrgId(scope);
  return {
    status,
    subscriptionPlan: { consultantProfileId },
    ...(scope.kind === "personal"
      ? { OR: [{ appointment: null }, { appointment: orgWhere }] }
      : // "all" keeps the old `some: {}` meaning: any allocated wrapper.
        { appointment: scope.kind === "all" ? { isNot: null } : orgWhere }),
  };
}

// ---------------------------------------------------------------------------
// #1675 PR-Y2 — "Add your bank account to get paid"
// ---------------------------------------------------------------------------

/**
 * The Home row shows only when money exists AND the account is what stops it:
 * no earnings means nothing to pay and no reason to nag, and a missing PAN
 * only over-withholds. Deliberately independent of ENABLE_LIVE_PAYOUTS — the
 * point of the row is to have every account in BEFORE the flag flips, so the
 * first batch reaches everyone on day one (coordinator correction 2026-09-20).
 */
export function payoutSetupNeeded(input: {
  requirements: Pick<PayoutRequirements, "currentlyDue">;
  earningsCount: number;
}): boolean {
  return (
    input.earningsCount >= 1 &&
    input.requirements.currentlyDue.some(
      (r) => r.code === "PAYOUT_ACCOUNT" || r.code === "ACCOUNT_VERIFICATION",
    )
  );
}

/** Sequential reads (PG_POOL_MAX=1), the earnings count first so a
 * consultant with nothing to pay costs one query. */
export async function readPayoutSetupNeeded(
  consultantProfileId: string,
): Promise<boolean> {
  const earningsCount = await prisma.consultantEarnings.count({
    where: { consultantProfileId },
  });
  if (earningsCount === 0) return false;
  const requirements = await readPayoutRequirements(consultantProfileId, {
    earningsCount,
  });
  return payoutSetupNeeded({ requirements, earningsCount });
}

/**
 * #1766 — an APPROVED subscription whose live cycle has finished: at least
 * one delivered session and no live SCHEDULED one. Whether entitlement is
 * left (remaining > 0) is decided in JS through the entitlement helper — the
 * predicate cannot count, so the caller filters after the read.
 */
export function nextCycleSubscriptionWhere(
  consultantProfileId: string,
  scope: Scope,
): Prisma.SubscriptionWhereInput {
  const scoped = subscriptionRequestWhere(
    consultantProfileId,
    scope,
    "APPROVED",
  );
  return {
    ...scoped,
    deletedAt: null,
    appointment: {
      ...(scoped.appointment as Prisma.AppointmentWhereInput | undefined),
      occurrences: {
        some: {
          completionStatus: { in: ["COMPLETED", "UNVERIFIED"] },
          deletedAt: null,
        },
        none: {
          completionStatus: "SCHEDULED",
          isTentative: false,
          deletedAt: null,
        },
      },
    },
  };
}

/**
 * @param userId              the signed-in user
 * @param consultantProfileId their delivering profile
 */
export async function getNeedsYouSummary(
  userId: string,
  consultantProfileId: string,
): Promise<NeedsYouSummary> {
  // Memberships + personal-scope counts share no dependency — fetch together
  // so the personal context does not wait on the membership round-trip.
  const [deliveringMemberships, personalConsultations, personalSubscriptions] =
    await Promise.all([
      prisma.membership.findMany({
        where: {
          userId,
          status: "ACTIVE",
          consultantProfileId,
          organization: { canHost: true },
        },
        select: {
          organizationId: true,
          organization: { select: { name: true } },
        },
      }),
      prisma.consultation.count({
        where: pendingConsultationWhere(consultantProfileId, {
          kind: "personal",
        }),
      }),
      prisma.subscription.count({
        where: pendingSubscriptionWhere(consultantProfileId, {
          kind: "personal",
        }),
      }),
    ]);

  const orgScopes = deliveringMemberships.map((m) => ({
    organizationId: m.organizationId as string,
    label: m.organization.name,
    href: `/dashboard/organization/${m.organizationId}/requests`,
  }));

  const orgCounts = await Promise.all(
    orgScopes.map(async (scope) => {
      const [consultations, subscriptions] = await Promise.all([
        prisma.consultation.count({
          where: pendingConsultationWhere(consultantProfileId, {
            kind: "org",
            orgId: scope.organizationId,
          }),
        }),
        prisma.subscription.count({
          where: pendingSubscriptionWhere(consultantProfileId, {
            kind: "org",
            orgId: scope.organizationId,
          }),
        }),
      ]);
      return {
        ...scope,
        pendingRequests: consultations + subscriptions,
      };
    }),
  );

  const contexts = [
    {
      organizationId: null,
      label: "Personal",
      href: `/dashboard/consultant/${consultantProfileId}/requests`,
      pendingRequests: personalConsultations + personalSubscriptions,
    },
    ...orgCounts,
  ].filter((c) => c.pendingRequests > 0);

  return {
    contexts,
    total: contexts.reduce((sum, c) => sum + c.pendingRequests, 0),
  };
}
