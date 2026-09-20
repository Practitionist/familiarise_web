/**
 * #1775 / #1704 / #1705 — the ONE read behind the consultant Requests inbox:
 * the RSC page seeds react-query with it, `/api/bookings/inbox` answers with
 * it, and the Home preview shows its first rows. Every row carries the input
 * `deriveBookingPresentation` (lib/dashboard/money-state.ts) reads, built the
 * way the payment history builds its own (lifecycleOf / planOf), so the inbox,
 * Home and the detail page cannot disagree about a booking.
 *
 * Cohort per type: consultation and subscription requests in PENDING and
 * APPROVED_PENDING_PAYMENT (the needs-you predicates Home counts with),
 * subscriptions whose live cycle is finished (#1766 next-cycle rows), and
 * trials in PENDING / AWAITING_PAYMENT. Chips narrow it server-side; sort
 * and paging happen here over a bounded scan because deadline, money and
 * bucket are derived, not stored.
 *
 * Auth stays with the caller: the route checks the session against
 * `consultantProfileId`, the page runs `requirePersonalProfileAccess`.
 */

import prisma from "@/lib/prisma";
import type { Prisma, TrialStatus } from "@prisma/client";
import { scopeToWhereOrgId, type Scope } from "@/lib/api/scope/parse";
import { lifecycleOf, planOf } from "@/lib/appointments/presentation-input";
import { isSponsoredPayment } from "@/lib/appointments/payment-display";
import {
  sessionsTotalOf,
  subscriptionEntitlement,
  type SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import {
  APPOINTMENT_LIST_SELECT,
  PROFILE_WITH_USER_SELECT,
} from "@/lib/booking/list-selects";
import {
  deriveBookingPresentation,
  requestHoldDeadline,
  type BookingPresentationInput,
  type PaymentInput,
} from "@/lib/dashboard/money-state";
import {
  INBOX_DEFAULT_LIMIT,
  inboxBucketOf,
  sortInboxRows,
  type InboxChip,
  type InboxRowInput,
  type InboxSort,
  type InboxType,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import {
  consultationRequestWhere,
  nextCycleSubscriptionWhere,
  pendingConsultationWhere,
  pendingSubscriptionWhere,
  subscriptionRequestWhere,
} from "@/lib/data/needs-you";
import { BUYER_PAYMENT_DISPLAY_SELECT } from "@/lib/data/payments-select";
import { toPlain } from "@/lib/data/serialize";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";

export interface ReadRequestsInboxArgs {
  consultantProfileId: string;
  /** Absent → personal (B2C), exactly as the list routes default. */
  orgScope?: Scope;
  type: InboxType;
  chip?: InboxChip;
  sort: InboxSort;
  page: number;
  limit?: number;
  now?: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SLOT_HOURS = 0.5;

/**
 * The wrapper as the inbox needs it: the list select plus the fields the
 * presentation reads (a payment's rail, clock and refunds; the EXPIRED edge).
 * Occurrences are bounded to non-tombstoned rows; RESCHEDULED rows stay
 * because the approve gate must tell them from a fresh hold (#1704 P1).
 */
const INBOX_APPOINTMENT_SELECT = {
  select: {
    ...APPOINTMENT_LIST_SELECT.select,
    occurrences: {
      ...APPOINTMENT_LIST_SELECT.select.occurrences,
      where: { deletedAt: null },
      select: {
        ...APPOINTMENT_LIST_SELECT.select.occurrences.select,
        deletedAt: true,
      },
    },
    payment: { select: BUYER_PAYMENT_DISPLAY_SELECT },
    organization: { select: { name: true } },
    statusHistory: {
      where: { toStatus: "EXPIRED" as const },
      select: { fromStatus: true, toStatus: true },
    },
  },
} as const;

const CONSULTATION_SELECT = {
  id: true,
  status: true,
  requestedAt: true,
  bookingSource: true,
  requestNotes: true,
  consultationPlan: {
    select: {
      id: true,
      title: true,
      durationInHours: true,
      price: true,
      priceCurrency: true,
      consultantProfile: PROFILE_WITH_USER_SELECT,
    },
  },
  requestedBy: PROFILE_WITH_USER_SELECT,
  appointment: INBOX_APPOINTMENT_SELECT,
} satisfies Prisma.ConsultationSelect;

const SUBSCRIPTION_SELECT = {
  id: true,
  status: true,
  requestedAt: true,
  bookingSource: true,
  requestNotes: true,
  schedulingPeriodStartsAt: true,
  schedulingPeriodEndsAt: true,
  schedulingTimezone: true,
  sessionsTotal: true,
  subscriptionPlan: {
    select: {
      id: true,
      title: true,
      sessionsPerWeek: true,
      durationInMonths: true,
      sessionDurationInHours: true,
      totalSessions: true,
      price: true,
      priceCurrency: true,
      consultantProfile: PROFILE_WITH_USER_SELECT,
    },
  },
  requestedBy: PROFILE_WITH_USER_SELECT,
  appointment: INBOX_APPOINTMENT_SELECT,
} satisfies Prisma.SubscriptionSelect;

const TRIAL_SELECT = {
  id: true,
  status: true,
  notes: true,
  requestedAt: true,
  paymentDueAt: true,
  consulteeProfile: PROFILE_WITH_USER_SELECT,
  subscriptionPlan: {
    select: {
      id: true,
      title: true,
      trialDurationMinutes: true,
      trialPriceInPaise: true,
      priceCurrency: true,
      consultantProfile: PROFILE_WITH_USER_SELECT,
    },
  },
  appointment: INBOX_APPOINTMENT_SELECT,
} satisfies Prisma.TrialSelect;

/** Rows read per sub-cohort before sorting; PENDING expires in 48 h / 30 d. */
const INBOX_SCAN = 200;

/** `[{ requestedAt desc }, { id asc }]` — a total order, so a scan is stable (#1704 P1). */
const INBOX_ORDER = [
  { requestedAt: "desc" },
  { id: "asc" },
] satisfies Prisma.ConsultationOrderByWithRelationInput[];

// Typed off the calls, not GetPayload: the read-path `$extends` hands money
// back as `number`, which GetPayload still spells `bigint`.
const findConsultations = (where: Prisma.ConsultationWhereInput) =>
  prisma.consultation.findMany({
    where: { ...where, deletedAt: null },
    select: CONSULTATION_SELECT,
    orderBy: INBOX_ORDER,
    take: INBOX_SCAN,
  });
const findSubscriptions = (
  where: Prisma.SubscriptionWhereInput,
  orderBy: Prisma.SubscriptionOrderByWithRelationInput[] = INBOX_ORDER,
) =>
  prisma.subscription.findMany({
    where: { ...where, deletedAt: null },
    select: SUBSCRIPTION_SELECT,
    orderBy,
    take: INBOX_SCAN,
  });
const findTrials = (where: Prisma.TrialWhereInput) =>
  prisma.trial.findMany({
    where,
    select: TRIAL_SELECT,
    orderBy: INBOX_ORDER,
    take: INBOX_SCAN,
  });

type ConsultationRow = Awaited<ReturnType<typeof findConsultations>>[number];
type SubscriptionRow = Awaited<ReturnType<typeof findSubscriptions>>[number];
type TrialRow = Awaited<ReturnType<typeof findTrials>>[number];
type AppointmentRow = NonNullable<ConsultationRow["appointment"]>;
type PaymentRow = AppointmentRow["payment"][number];

function toPaymentInput(p: PaymentRow): PaymentInput {
  return {
    id: p.id,
    paymentStatus: p.paymentStatus,
    paymentMethod: p.paymentMethod,
    paymentGateway: p.paymentGateway,
    receiptUrl: p.receiptUrl,
    consumerInvoice: p.consumerInvoice,
    legs: p.legs,
    refunds: p.refunds,
    amount: p.amount,
    taxAmount: p.taxAmount,
    currency: p.currency,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
  };
}

/** The soonest live pay-link clock on the wrapper, if one is minted. */
function pendingPayLinkDeadline(a: AppointmentRow | null): Date | null {
  return (
    (a?.payment ?? [])
      .filter((p) => p.paymentStatus === "PENDING" && p.expiresAt)
      .map((p) => new Date(p.expiresAt as Date))
      .sort((x, y) => x.getTime() - y.getTime())[0] ?? null
  );
}

/** The same rule as presentationNames: the requester pays, the plan's owner delivers. */
function namesOf(
  requester: { user: { name: string | null } } | null,
  consultant: { user: { name: string | null } } | null,
): InboxRowInput["names"] {
  return {
    payer: requester?.user.name ?? "The attendee",
    consultant: consultant?.user.name ?? "The consultant",
  };
}

function wrapperFacts(a: AppointmentRow | null, appointmentType: string) {
  const slots = a?.occurrences ?? [];
  return {
    appointmentType,
    occurrences: slots,
    payments: (a?.payment ?? []).map(toPaymentInput),
    refunds: (a?.payment ?? []).flatMap((p) => p.refunds),
    disputes: (a?.payment ?? []).flatMap((p) => p.disputes),
    // The consultant is never the co-payer, so no child rows are theirs.
    childPayments: [] as PaymentInput[],
    sponsorOrgName: (a?.payment ?? []).some(isSponsoredPayment)
      ? (a?.organization?.name ?? null)
      : null,
    history: a?.statusHistory ?? [],
    slots: slots.map((s) => ({
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      isTentative: s.isTentative,
      completionStatus: s.completionStatus,
    })),
    tentativeSlotCount: slots.filter((s) => s.isTentative).length,
    rescheduledSlotCount: slots.filter(isReleasedForReschedule).length,
    proposal: a?.rescheduleRequests[0]
      ? {
          ...a.rescheduleRequests[0],
          reason: a.rescheduleRequests[0].reason ?? null,
          preferredTimeOfDay:
            a.rescheduleRequests[0].preferredTimeOfDay ?? null,
          preferredDays: a.rescheduleRequests[0].preferredDays ?? null,
        }
      : null,
  };
}

const money = (v: bigint | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

function hrefsFor(
  consultantProfileId: string,
  requestId: string,
  appointmentId: string | null,
  type: "consultation" | "subscription" | null,
): InboxRowInput["hrefs"] {
  const cp = encodeURIComponent(consultantProfileId);
  return {
    detail: appointmentId
      ? `/dashboard/consultant/${cp}/appointments/${encodeURIComponent(appointmentId)}`
      : null,
    allocate: type
      ? `/dashboard/consultant/${cp}/requests/${encodeURIComponent(requestId)}/allocate?type=${type}`
      : null,
  };
}

/** The last step every row takes: derive once, so bucket and words agree. */
function finish(row: Omit<InboxRowInput, "bucket">, now: Date): InboxRowInput {
  const { bookingState } = deriveBookingPresentation(
    row.presentation,
    "CONSULTANT",
    { now },
  );
  return { ...row, bucket: inboxBucketOf(row, bookingState.state, now) };
}

function consultationRow(
  c: ConsultationRow,
  consultantProfileId: string,
  now: Date,
): InboxRowInput {
  const request = lifecycleOf({ consultation: c });
  const facts = wrapperFacts(c.appointment, "CONSULTATION");
  const holdDeadline =
    c.status === "PENDING"
      ? requestHoldDeadline("CONSULTATION", c.requestedAt)
      : null;
  const deadline = pendingPayLinkDeadline(c.appointment) ?? holdDeadline;
  const presentation: BookingPresentationInput = {
    ...facts,
    request,
    holdExpiresAt: deadline,
    plan: planOf({ consultation: c }),
    names: namesOf(c.requestedBy, c.consultationPlan.consultantProfile),
  };
  return finish(
    {
      id: c.id,
      kind: "consultation",
      appointmentId: c.appointment?.id ?? null,
      planTitle: c.consultationPlan.title,
      requester: {
        name: c.requestedBy.user.name ?? "Consultee",
        image: c.requestedBy.user.image ?? null,
      },
      requestedAt: c.requestedAt,
      deadline,
      amountPaise: money(c.consultationPlan.price),
      currency: c.consultationPlan.priceCurrency,
      presentation,
      names: presentation.names,
      hrefs: hrefsFor(
        consultantProfileId,
        c.id,
        c.appointment?.id ?? null,
        "consultation",
      ),
      requestNotes: c.requestNotes,
      bookingSource: c.bookingSource,
      slots: facts.slots,
      requiredSlots: Math.max(
        1,
        Math.ceil((c.consultationPlan.durationInHours || 1) / SLOT_HOURS),
      ),
      tentativeSlotCount: facts.tentativeSlotCount,
      rescheduledSlotCount: facts.rescheduledSlotCount,
      proposal: facts.proposal,
      schedulingPeriod: null,
      schedulingTimezone: null,
      entitlement: null,
      trial: null,
    },
    now,
  );
}

/** The fields the entitlement needs; the slim next-cycle count reads only these. */
const ENTITLEMENT_SELECT = {
  id: true,
  sessionsTotal: true,
  schedulingPeriodStartsAt: true,
  schedulingTimezone: true,
  subscriptionPlan: {
    select: {
      sessionsPerWeek: true,
      durationInMonths: true,
      totalSessions: true,
    },
  },
  appointment: {
    select: {
      occurrences: {
        where: { deletedAt: null },
        select: {
          startsAt: true,
          endsAt: true,
          isTentative: true,
          completionStatus: true,
          deletedAt: true,
        },
      },
    },
  },
} satisfies Prisma.SubscriptionSelect;

type EntitlementRow = Prisma.SubscriptionGetPayload<{
  select: typeof ENTITLEMENT_SELECT;
}>;

function entitlementOf(
  s: EntitlementRow,
  now: Date,
): SubscriptionEntitlement | null {
  const total = sessionsTotalOf(s);
  if (!(total > 0) || !s.schedulingPeriodStartsAt) return null;
  return subscriptionEntitlement({
    sessionsTotal: total,
    sessionsPerWeek: s.subscriptionPlan.sessionsPerWeek,
    durationInMonths: s.subscriptionPlan.durationInMonths,
    occurrences: (s.appointment?.occurrences ?? []).map((o) => ({
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      completionStatus: o.completionStatus,
      isTentative: o.isTentative,
      deletedAt: o.deletedAt,
    })),
    schedulingPeriodStartsAt: s.schedulingPeriodStartsAt,
    schedulingTimezone: s.schedulingTimezone,
    now,
  });
}

function subscriptionRow(
  s: SubscriptionRow,
  consultantProfileId: string,
  now: Date,
  kind: "subscription" | "next-cycle",
): InboxRowInput {
  const request = lifecycleOf({ subscription: s });
  const facts = wrapperFacts(s.appointment, "SUBSCRIPTION");
  const entitlement = entitlementOf(s, now);
  const holdDeadline =
    s.status === "PENDING"
      ? requestHoldDeadline("SUBSCRIPTION", s.requestedAt)
      : null;
  // A next-cycle row's clock is the cycle window it must be placed in.
  const deadline =
    kind === "next-cycle"
      ? (entitlement?.cycle.windowStart ?? null)
      : (pendingPayLinkDeadline(s.appointment) ?? holdDeadline);
  const presentation: BookingPresentationInput = {
    ...facts,
    request,
    holdExpiresAt: kind === "next-cycle" ? null : deadline,
    plan: planOf({ subscription: s }),
    names: namesOf(s.requestedBy, s.subscriptionPlan.consultantProfile),
  };
  const slotsPerSession = Math.max(
    1,
    Math.ceil((s.subscriptionPlan.sessionDurationInHours || 1) / SLOT_HOURS),
  );
  // A reschedule replaces only the released rows; a fresh request places
  // the next cycle's batch (#1766); a plan that cannot say is disabled.
  const requiredSlots =
    facts.tentativeSlotCount > 0
      ? facts.tentativeSlotCount
      : entitlement
        ? entitlement.cycle.nextBatch * slotsPerSession
        : null;
  return finish(
    {
      id: s.id,
      kind,
      appointmentId: s.appointment?.id ?? null,
      planTitle: s.subscriptionPlan.title,
      requester: {
        name: s.requestedBy.user.name ?? "Consultee",
        image: s.requestedBy.user.image ?? null,
      },
      requestedAt: s.requestedAt,
      deadline,
      amountPaise: money(s.subscriptionPlan.price),
      currency: s.subscriptionPlan.priceCurrency,
      presentation,
      names: presentation.names,
      hrefs: hrefsFor(
        consultantProfileId,
        s.id,
        s.appointment?.id ?? null,
        "subscription",
      ),
      requestNotes: s.requestNotes,
      bookingSource: s.bookingSource,
      slots: facts.slots,
      requiredSlots,
      tentativeSlotCount: facts.tentativeSlotCount,
      rescheduledSlotCount: facts.rescheduledSlotCount,
      proposal: facts.proposal,
      schedulingPeriod: {
        start: s.schedulingPeriodStartsAt,
        end: s.schedulingPeriodEndsAt,
      },
      schedulingTimezone: s.schedulingTimezone,
      entitlement,
      trial: null,
    },
    now,
  );
}

function trialRow(
  t: TrialRow,
  consultantProfileId: string,
  now: Date,
): InboxRowInput {
  const request = lifecycleOf({ trial: t });
  const facts = wrapperFacts(t.appointment, "TRIAL");
  // A paid trial's pay link runs to paymentDueAt; a request has no clock of
  // its own (no sweep expires a PENDING trial), so the bucket treats it as due.
  const deadline =
    pendingPayLinkDeadline(t.appointment) ??
    (t.status === "AWAITING_PAYMENT" ? t.paymentDueAt : null);
  const presentation: BookingPresentationInput = {
    ...facts,
    request,
    holdExpiresAt: deadline,
    plan: planOf({ trial: t }),
    names: namesOf(t.consulteeProfile, t.subscriptionPlan.consultantProfile),
  };
  const price = money(t.subscriptionPlan.trialPriceInPaise);
  return finish(
    {
      id: t.id,
      kind: "trial",
      appointmentId: t.appointment?.id ?? null,
      planTitle: t.subscriptionPlan.title,
      requester: {
        name: t.consulteeProfile.user.name ?? "Consultee",
        image: t.consulteeProfile.user.image ?? null,
      },
      requestedAt: t.requestedAt,
      deadline,
      amountPaise: price && price > 0 ? price : null,
      currency: t.subscriptionPlan.priceCurrency,
      presentation,
      names: presentation.names,
      hrefs: hrefsFor(
        consultantProfileId,
        t.id,
        t.appointment?.id ?? null,
        null,
      ),
      requestNotes: t.notes,
      bookingSource: null,
      slots: facts.slots,
      requiredSlots: null,
      tentativeSlotCount: facts.tentativeSlotCount,
      rescheduledSlotCount: facts.rescheduledSlotCount,
      proposal: facts.proposal,
      schedulingPeriod: null,
      schedulingTimezone: null,
      entitlement: null,
      trial: { durationMinutes: t.subscriptionPlan.trialDurationMinutes },
    },
    now,
  );
}

const PERSONAL: Scope = { kind: "personal" };

/** Trials are scoped by their own `organizationId` column, as `/api/trials` does. */
function trialWhere(
  consultantProfileId: string,
  scope: Scope,
  statuses: TrialStatus[],
): Prisma.TrialWhereInput {
  return {
    ...scopeToWhereOrgId(scope),
    consultantProfileId,
    deletedAt: null,
    status: { in: statuses },
  };
}

/** "Answer today" server-side: the hold (48 h / 30 d) has under 24 h left. */
function dueWithinDay(holdMs: number, now: Date): { lte: Date } {
  return { lte: new Date(now.getTime() - (holdMs - DAY_MS)) };
}
const CONSULTATION_HOLD_MS = 48 * HOUR_MS;
const SUBSCRIPTION_HOLD_MS = 30 * DAY_MS;

interface CohortPlan {
  consultationStatuses: Prisma.ConsultationWhereInput[];
  subscriptionStatuses: Prisma.SubscriptionWhereInput[];
  nextCycle: boolean;
  trialStatuses: TrialStatus[];
}

/** Which sub-cohorts a (type, chip) pair reads; every predicate is needs-you's. */
function planCohort(
  cp: string,
  scope: Scope,
  type: InboxType,
  chip: InboxChip | undefined,
  now: Date,
): CohortPlan {
  const plan: CohortPlan = {
    consultationStatuses: [],
    subscriptionStatuses: [],
    nextCycle: false,
    trialStatuses: [],
  };
  if (type === "consultation") {
    if (!chip) {
      plan.consultationStatuses = [
        pendingConsultationWhere(cp, scope),
        consultationRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
      ];
    } else if (chip === "answer-today") {
      plan.consultationStatuses = [
        {
          ...pendingConsultationWhere(cp, scope),
          requestedAt: dueWithinDay(CONSULTATION_HOLD_MS, now),
        },
      ];
    } else if (chip === "awaiting-payment") {
      plan.consultationStatuses = [
        consultationRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
      ];
    } else if (chip === "declined") {
      plan.consultationStatuses = [
        consultationRequestWhere(cp, scope, "REJECTED"),
      ];
    }
  } else if (type === "subscription") {
    if (!chip) {
      plan.subscriptionStatuses = [
        pendingSubscriptionWhere(cp, scope),
        subscriptionRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
      ];
      plan.nextCycle = true;
    } else if (chip === "answer-today") {
      plan.subscriptionStatuses = [
        {
          ...pendingSubscriptionWhere(cp, scope),
          requestedAt: dueWithinDay(SUBSCRIPTION_HOLD_MS, now),
        },
      ];
    } else if (chip === "awaiting-payment") {
      plan.subscriptionStatuses = [
        subscriptionRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
      ];
    } else if (chip === "next-cycle") {
      plan.nextCycle = true;
    } else if (chip === "declined") {
      plan.subscriptionStatuses = [
        subscriptionRequestWhere(cp, scope, "REJECTED"),
      ];
    }
  } else if (!chip || chip === "answer-today") {
    plan.trialStatuses = chip ? ["PENDING"] : ["PENDING", "AWAITING_PAYMENT"];
  } else if (chip === "awaiting-payment") {
    plan.trialStatuses = ["AWAITING_PAYMENT"];
  } else if (chip === "declined") {
    plan.trialStatuses = ["REJECTED"];
  }
  return plan;
}

/** Sequential reads on purpose: PG_POOL_MAX=1 serialises them anyway. */
async function readCohort(
  cp: string,
  scope: Scope,
  plan: CohortPlan,
  now: Date,
): Promise<InboxRowInput[]> {
  const rows: InboxRowInput[] = [];
  for (const where of plan.consultationStatuses) {
    const found = await findConsultations(where);
    rows.push(...found.map((c) => consultationRow(c, cp, now)));
  }
  for (const where of plan.subscriptionStatuses) {
    const found = await findSubscriptions(where);
    rows.push(...found.map((s) => subscriptionRow(s, cp, now, "subscription")));
  }
  if (plan.nextCycle) rows.push(...(await readNextCycleRows(cp, scope, now)));
  if (plan.trialStatuses.length > 0) {
    const found = await findTrials(trialWhere(cp, scope, plan.trialStatuses));
    rows.push(...found.map((t) => trialRow(t, cp, now)));
  }
  return rows;
}

/** #1766 — the predicate cannot count; `remaining > 0` is decided here. */
async function readNextCycleRows(
  cp: string,
  scope: Scope,
  now: Date,
): Promise<InboxRowInput[]> {
  const candidates = await findSubscriptions(
    nextCycleSubscriptionWhere(cp, scope),
    [{ updatedAt: "asc" }, { id: "asc" }],
  );
  return candidates
    .map((s) => subscriptionRow(s, cp, now, "next-cycle"))
    .filter((row) => (row.entitlement?.remaining ?? 0) > 0);
}

/** #1766 — how many finished cycles still have sessions left, without building rows. */
async function countNextCycle(
  cp: string,
  scope: Scope,
  now: Date,
): Promise<number> {
  const candidates = await prisma.subscription.findMany({
    where: { ...nextCycleSubscriptionWhere(cp, scope), deletedAt: null },
    select: ENTITLEMENT_SELECT,
    take: INBOX_SCAN,
  });
  return candidates.filter((s) => (entitlementOf(s, now)?.remaining ?? 0) > 0)
    .length;
}

/** Tab labels: the default cohort's size per type, read with the same predicates. */
async function readCounts(
  cp: string,
  scope: Scope,
  now: Date,
  known: { type: InboxType; total: number } | null,
): Promise<Record<InboxType, number>> {
  const counts: Record<InboxType, number> = {
    consultation: 0,
    subscription: 0,
    trial: 0,
  };
  if (known?.type === "consultation") counts.consultation = known.total;
  else {
    counts.consultation =
      (await prisma.consultation.count({
        where: { ...pendingConsultationWhere(cp, scope), deletedAt: null },
      })) +
      (await prisma.consultation.count({
        where: {
          ...consultationRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
          deletedAt: null,
        },
      }));
  }
  if (known?.type === "subscription") counts.subscription = known.total;
  else {
    counts.subscription =
      (await prisma.subscription.count({
        where: { ...pendingSubscriptionWhere(cp, scope), deletedAt: null },
      })) +
      (await prisma.subscription.count({
        where: {
          ...subscriptionRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
          deletedAt: null,
        },
      })) +
      (await countNextCycle(cp, scope, now));
  }
  if (known?.type === "trial") counts.trial = known.total;
  else {
    counts.trial = await prisma.trial.count({
      where: trialWhere(cp, scope, ["PENDING", "AWAITING_PAYMENT"]),
    });
  }
  return counts;
}

export async function readRequestsInbox(
  args: ReadRequestsInboxArgs,
): Promise<RequestsInboxPayload> {
  const now = args.now ?? new Date();
  const scope = args.orgScope ?? PERSONAL;
  const limit = args.limit ?? INBOX_DEFAULT_LIMIT;
  const cp = args.consultantProfileId;
  const plan = planCohort(cp, scope, args.type, args.chip, now);
  const cohort = sortInboxRows(
    await readCohort(cp, scope, plan, now),
    args.sort,
  );
  const total = cohort.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, args.page), pages);
  const rows = cohort.slice((page - 1) * limit, page * limit);
  const counts = await readCounts(
    cp,
    scope,
    now,
    args.chip ? null : { type: args.type, total },
  );
  return toPlain({ rows, meta: { total, page, limit, counts } });
}
