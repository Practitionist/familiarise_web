import prisma from "@/lib/prisma";
import type { AppointmentStatus, Prisma, TrialStatus } from "@prisma/client";
import type { Scope } from "@/lib/api/scope/parse";
import {
  ORG_SCOPE_READABLE_STATUSES,
  scopeToPlanHostWhere,
} from "@/lib/api/scope/parse";
import {
  ANSWERABLE_CONSULTATION,
  ANSWERABLE_SUBSCRIPTION,
} from "@/lib/booking/request-cohort";
import { runBounded } from "@/lib/db/bounded";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import { RESTORABLE_ORIGINS } from "@/lib/appointments/lapsed-move";
import { requestHoldDeadline } from "@/lib/dashboard/money-state";
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
 * Requests split on the plan's HOST org (`scopeToPlanHostWhere`): personal is
 * every request on a plan no org hosts, sponsor-tagged or not, so a sponsored
 * learner's request reaches the expert who must answer it. Exported because
 * the Home badge, NeedsYou and the inbox count the same cohort.
 */
export function pendingConsultationWhere(
  consultantProfileId: string,
  scope: Scope,
  now: Date = new Date(),
): Prisma.ConsultationWhereInput {
  return {
    AND: [
      consultationRequestWhere(consultantProfileId, scope, "PENDING"),
      ANSWERABLE_CONSULTATION,
      { NOT: { appointment: lapsedMoveWhere(now) } },
    ],
  };
}

/**
 * A booking whose open move passed its deadline and restores off PENDING: it
 * reads as the original (withLapsedMoveRestored), so it is no request to answer.
 */
export function lapsedMoveWhere(now: Date): Prisma.AppointmentWhereInput {
  return {
    rescheduleRequests: {
      some: {
        status: { in: RESCHEDULE_OPEN_STATUSES },
        NOT: answerableBy(now),
        originStatus: { in: RESTORABLE_ORIGINS },
      },
    },
  };
}

/** A proposal still inside its deadline: past it the original stands and nothing is left to answer. */
export function answerableBy(now: Date) {
  return {
    expiresAt: { gt: now },
  } satisfies Prisma.RescheduleRequestWhereInput;
}

/** The pending predicate at any status; Home's "Awaiting payment" row reads
 * it at APPROVED_PENDING_PAYMENT so the two cohorts share one scope. #1703 */
export function consultationRequestWhere(
  consultantProfileId: string,
  scope: Scope,
  status: AppointmentStatus,
): Prisma.ConsultationWhereInput {
  return {
    status,
    consultationPlan: { consultantProfileId, ...scopeToPlanHostWhere(scope) },
  };
}

// #1638 made Subscription.appointment singular; the return is typed so the
// next relation rename fails tsc instead of the dashboard route (FAMILIARISE_WEB-3Y).
export function pendingSubscriptionWhere(
  consultantProfileId: string,
  scope: Scope,
  now: Date = new Date(),
): Prisma.SubscriptionWhereInput {
  return {
    AND: [
      subscriptionRequestWhere(consultantProfileId, scope, "PENDING"),
      ANSWERABLE_SUBSCRIPTION,
      { NOT: { appointment: lapsedMoveWhere(now) } },
    ],
    deletedAt: null,
  };
}

/** Trials split on their subscription plan's host org, like every request. */
export function trialRequestWhere(
  consultantProfileId: string,
  scope: Scope,
  statuses: TrialStatus[],
): Prisma.TrialWhereInput {
  return {
    subscriptionPlan: { ...scopeToPlanHostWhere(scope) },
    consultantProfileId,
    // No `deletedAt`: every terminal trial outcome is a TrialStatus value, so
    // the status filter below is already the liveness test. See the Trial model.
    status: { in: statuses },
  };
}

/**
 * A booking a reschedule put back to PENDING: an open proposal, or sessions
 * released and not yet re-placed. It is being moved, not newly requested.
 */
export const BEING_MOVED = {
  OR: [
    { rescheduleRequests: { some: { status: "PENDING_REVIEW" } } },
    {
      occurrences: {
        some: {
          isTentative: true,
          completionStatus: "RESCHEDULED",
          deletedAt: null,
        },
      },
    },
  ],
} satisfies Prisma.AppointmentWhereInput;

/** The consultant's own open proposal waits on the client, never on them. */
const AWAITING_CLIENT_ANSWER = {
  appointment: {
    rescheduleRequests: {
      some: {
        status: "PENDING_REVIEW",
        initiatorRole: "CONSULTANT",
        proposedTimes: { some: {} },
      },
    },
  },
} satisfies Prisma.ConsultationWhereInput & Prisma.SubscriptionWhereInput;

/**
 * An APPROVED consultation whose whole-booking reschedule ended (declined or
 * expired) after its original time was claimed by another booking: its only
 * occurrences are still `RESCHEDULED`, no live confirmed session exists, and
 * no `PENDING_REVIEW` proposal remains open. The Requests inbox lists it and
 * the requests-to-answer number counts it, so the consultant places a new time
 * before the booking is cancelled and refunded.
 */
export function strandedApprovedConsultationWhere(
  cp: string,
  scope: Scope,
): Prisma.ConsultationWhereInput {
  return {
    status: "APPROVED",
    consultationPlan: {
      consultantProfileId: cp,
      ...scopeToPlanHostWhere(scope),
    },
    appointment: {
      occurrences: {
        some: { completionStatus: "RESCHEDULED", deletedAt: null },
        none: {
          completionStatus: {
            in: ["SCHEDULED", "COMPLETED", "UNVERIFIED"],
          },
          isTentative: false,
          deletedAt: null,
        },
      },
      rescheduleRequests: {
        none: { status: "PENDING_REVIEW" },
      },
    },
  };
}

/**
 * The one "requests to answer" number: PENDING consultations and live
 * subscriptions that are real requests (never an unpaid checkout in flight),
 * and paid consultations parked without a time. A trial never waits on the
 * expert, and a plan week to schedule is not counted. The nav badge, Home and
 * NeedsYou read it, so they cannot disagree. `db` lets a caller count inside its lock.
 */
export async function countRequestsToAnswer(
  args: { consultantProfileId: string; orgScope?: Scope },
  db: RequestCounters = prisma,
): Promise<number> {
  const { consultation, subscription } = await countRequestsToAnswerByTab(
    args,
    db,
  );
  return consultation + subscription;
}

/** The same number split by the Requests tab its rows are listed on. */
export async function countRequestsToAnswerByTab(
  args: { consultantProfileId: string; orgScope?: Scope },
  db: RequestCounters = prisma,
): Promise<{ consultation: number; subscription: number }> {
  const cp = args.consultantProfileId;
  const scope = args.orgScope ?? { kind: "personal" };
  const [consultations, subscriptions] = await runBounded([
    () =>
      db.consultation.count({
        where: {
          OR: [
            {
              ...pendingConsultationWhere(cp, scope),
              NOT: AWAITING_CLIENT_ANSWER,
            },
            strandedApprovedConsultationWhere(cp, scope),
          ],
        },
      }),
    () =>
      db.subscription.count({
        where: {
          ...pendingSubscriptionWhere(cp, scope),
          NOT: AWAITING_CLIENT_ANSWER,
        },
      }),
  ] as const);
  return { consultation: consultations, subscription: subscriptions };
}

/** A PENDING request asked for at or after this instant still holds its slots. */
export function holdingSince(
  kind: "CONSULTATION" | "SUBSCRIPTION",
  now: Date,
): Date {
  const releasesAt = requestHoldDeadline(kind, now) ?? now;
  return new Date(2 * now.getTime() - releasesAt.getTime());
}

/** A submitted 1:1 request still waiting on the expert inside its hold. */
export function openConsultationRequestWhere(
  consultantProfileId: string,
  now: Date,
): Prisma.ConsultationWhereInput {
  return {
    status: "PENDING",
    bookingSource: "REQUEST_SUBMITTED",
    consultationPlan: { consultantProfileId },
    requestedAt: { gte: holdingSince("CONSULTATION", now) },
    NOT: { appointment: BEING_MOVED },
  };
}

/**
 * The request cap's count, across every tenant: real submitted requests
 * (PENDING, REQUEST_SUBMITTED, still inside their hold, not a booking being
 * moved); a trial never waits on the expert. No appointment arm, so an unallocated
 * request counts, and no direct checkout ever does. Call it inside the cap
 * lock with `tx`.
 */
export async function countOpenRequestsForCap(
  consultantProfileId: string,
  db: RequestCounters = prisma,
  now: Date = new Date(),
): Promise<number> {
  const [consultations, subscriptions] = await runBounded([
    () =>
      db.consultation.count({
        where: openConsultationRequestWhere(consultantProfileId, now),
      }),
    () =>
      db.subscription.count({
        where: {
          status: "PENDING",
          bookingSource: "REQUEST_SUBMITTED",
          deletedAt: null,
          subscriptionPlan: { consultantProfileId },
          requestedAt: { gte: holdingSince("SUBSCRIPTION", now) },
          NOT: { appointment: BEING_MOVED },
        },
      }),
  ] as const);
  return consultations + subscriptions;
}

// Structural, not Pick<PrismaClient>: the extended client (lib/prisma) and a
// transaction client both satisfy it, and tsc rejects a dropped column.
export type RequestCounters = {
  consultation: {
    count: (args: { where: Prisma.ConsultationWhereInput }) => Promise<number>;
  };
  subscription: {
    count: (args: { where: Prisma.SubscriptionWhereInput }) => Promise<number>;
  };
  trial: {
    count: (args: { where: Prisma.TrialWhereInput }) => Promise<number>;
  };
};

export function subscriptionRequestWhere(
  consultantProfileId: string,
  scope: Scope,
  status: AppointmentStatus,
): Prisma.SubscriptionWhereInput {
  return {
    status,
    subscriptionPlan: { consultantProfileId, ...scopeToPlanHostWhere(scope) },
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
  return {
    ...subscriptionRequestWhere(consultantProfileId, scope, "APPROVED"),
    deletedAt: null,
    appointment: {
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
  const deliveringMemberships = await prisma.membership.findMany({
    where: {
      userId,
      status: "ACTIVE",
      consultantProfileId,
      organization: {
        canHost: true,
        status: { in: ORG_SCOPE_READABLE_STATUSES },
      },
    },
    select: {
      organizationId: true,
      organization: { select: { name: true } },
    },
    relationLoadStrategy: "join",
  });
  const personalRequests = await countRequestsToAnswer({ consultantProfileId });

  const orgScopes = deliveringMemberships.map((m) => ({
    organizationId: m.organizationId as string,
    label: m.organization.name,
    href: `/dashboard/organization/${m.organizationId}/requests`,
  }));

  // One org at a time: each count already runs its three reads bounded.
  const orgCounts: NeedsYouContext[] = [];
  for (const scope of orgScopes) {
    orgCounts.push({
      ...scope,
      pendingRequests: await countRequestsToAnswer({
        consultantProfileId,
        orgScope: { kind: "org", orgId: scope.organizationId },
      }),
    });
  }

  const contexts = [
    {
      organizationId: null,
      label: "Personal",
      href: `/dashboard/consultant/${consultantProfileId}/requests`,
      pendingRequests: personalRequests,
    },
    ...orgCounts,
  ].filter((c) => c.pendingRequests > 0);

  return {
    contexts,
    total: contexts.reduce((sum, c) => sum + c.pendingRequests, 0),
  };
}
