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
  if (total <= 0 || !s.schedulingPeriodStartsAt) return null;
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
  const freshBatch = entitlement
    ? entitlement.cycle.nextBatch * slotsPerSession
    : null;
  const requiredSlots =
    facts.tentativeSlotCount > 0 ? facts.tentativeSlotCount : freshBatch;
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

type ChipKey = InboxChip | "all";
const chipKey = (chip: InboxChip | undefined): ChipKey => chip ?? "all";

/** The consultation sub-cohorts a chip reads; an unknown chip reads nothing. */
function consultationCohort(
  cp: string,
  scope: Scope,
  chip: InboxChip | undefined,
  now: Date,
): Prisma.ConsultationWhereInput[] {
  const awaiting = consultationRequestWhere(
    cp,
    scope,
    "APPROVED_PENDING_PAYMENT",
  );
  const byChip: Partial<Record<ChipKey, Prisma.ConsultationWhereInput[]>> = {
    all: [pendingConsultationWhere(cp, scope), awaiting],
    "answer-today": [
      {
        ...pendingConsultationWhere(cp, scope),
        requestedAt: dueWithinDay(CONSULTATION_HOLD_MS, now),
      },
    ],
    "awaiting-payment": [awaiting],
    declined: [consultationRequestWhere(cp, scope, "REJECTED")],
  };
  return byChip[chipKey(chip)] ?? [];
}

/** The subscription sub-cohorts a chip reads, plus whether next-cycle rows join. */
function subscriptionCohort(
  cp: string,
  scope: Scope,
  chip: InboxChip | undefined,
  now: Date,
): { statuses: Prisma.SubscriptionWhereInput[]; nextCycle: boolean } {
  const awaiting = subscriptionRequestWhere(
    cp,
    scope,
    "APPROVED_PENDING_PAYMENT",
  );
  const byChip: Partial<Record<ChipKey, Prisma.SubscriptionWhereInput[]>> = {
    all: [pendingSubscriptionWhere(cp, scope), awaiting],
    "answer-today": [
      {
        ...pendingSubscriptionWhere(cp, scope),
        requestedAt: dueWithinDay(SUBSCRIPTION_HOLD_MS, now),
      },
    ],
    "awaiting-payment": [awaiting],
    "next-cycle": [],
    declined: [subscriptionRequestWhere(cp, scope, "REJECTED")],
  };
  return {
    statuses: byChip[chipKey(chip)] ?? [],
    nextCycle: chip === undefined || chip === "next-cycle",
  };
}

/** A trial has no hold clock, so "answer today" is every pending one. */
function trialCohort(chip: InboxChip | undefined): TrialStatus[] {
  const byChip: Partial<Record<ChipKey, TrialStatus[]>> = {
    all: ["PENDING", "AWAITING_PAYMENT"],
    "answer-today": ["PENDING"],
    "awaiting-payment": ["AWAITING_PAYMENT"],
    declined: ["REJECTED"],
  };
  return byChip[chipKey(chip)] ?? [];
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
    plan.consultationStatuses = consultationCohort(cp, scope, chip, now);
  } else if (type === "subscription") {
    const sub = subscriptionCohort(cp, scope, chip, now);
    plan.subscriptionStatuses = sub.statuses;
    plan.nextCycle = sub.nextCycle;
  } else {
    plan.trialStatuses = trialCohort(chip);
  }
  return plan;
}

/**
 * Bounded concurrency for the serverless pool: with PG_POOL_MAX=1 every extra
 * concurrent query queues behind the single connection, and a 6-deep queue at
 * ~700ms each can exceed the 3s PG_CONNECT_TIMEOUT_MS before it starts.
 * Cap in-flight reads (2 when pool<=1, else 6) instead of unbounded
 * Promise.all — still parallel locally, safe on Netlify.
 */
function poolLimit(): number {
  const max = Number(process.env.PG_POOL_MAX);
  return Number.isFinite(max) && max <= 1 ? 2 : 6;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    });
  await Promise.all(workers);
  return out;
}

/**
 * Cohort reads run concurrently (bounded): each sub-cohort is an independent
 * bounded scan (take 200), so serial awaits only summed their latencies.
 */
async function readCohort(
  cp: string,
  scope: Scope,
  plan: CohortPlan,
  now: Date,
): Promise<InboxRowInput[]> {
  const limit = poolLimit();
  const [consultationGroups, subscriptionGroups, nextCycleRows, trialRows] =
    await Promise.all([
      mapLimit(plan.consultationStatuses, limit, async (where) => {
        const found = await findConsultations(where);
        return found.map((c) => consultationRow(c, cp, now));
      }),
      mapLimit(plan.subscriptionStatuses, limit, async (where) => {
        const found = await findSubscriptions(where);
        return found.map((s) => subscriptionRow(s, cp, now, "subscription"));
      }),
      plan.nextCycle ? readNextCycleRows(cp, scope, now) : Promise.resolve([]),
      plan.trialStatuses.length > 0
        ? findTrials(trialWhere(cp, scope, plan.trialStatuses)).then((found) =>
            found.map((t) => trialRow(t, cp, now)),
          )
        : Promise.resolve([]),
    ]);
  return [
    ...consultationGroups.flat(),
    ...subscriptionGroups.flat(),
    ...nextCycleRows,
    ...trialRows,
  ];
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
  // Counts are independent but pool-bounded (see poolLimit above): 6 at once
  // can queue past PG_CONNECT_TIMEOUT_MS on pool=1. The `known` shortcut
  // still avoids re-counting the active tab (its total came from the cohort).
  type CountTask = () => Promise<number>;
  const tasks: CountTask[] = [];
  if (known?.type !== "consultation") {
    tasks.push(() =>
      prisma.consultation.count({
        where: { ...pendingConsultationWhere(cp, scope), deletedAt: null },
      }),
    );
    tasks.push(() =>
      prisma.consultation.count({
        where: {
          ...consultationRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
          deletedAt: null,
        },
      }),
    );
  }
  if (known?.type !== "subscription") {
    tasks.push(() =>
      prisma.subscription.count({
        where: { ...pendingSubscriptionWhere(cp, scope), deletedAt: null },
      }),
    );
    tasks.push(() =>
      prisma.subscription.count({
        where: {
          ...subscriptionRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
          deletedAt: null,
        },
      }),
    );
    tasks.push(() => countNextCycle(cp, scope, now));
  }
  if (known?.type !== "trial") {
    tasks.push(() =>
      prisma.trial.count({
        where: trialWhere(cp, scope, ["PENDING", "AWAITING_PAYMENT"]),
      }),
    );
  }
  const results = await mapLimit(tasks, poolLimit(), (run) => run());
  let i = 0;
  const consultationPending =
    known?.type === "consultation" ? 0 : (results[i++] ?? 0);
  const consultationAwaiting =
    known?.type === "consultation" ? 0 : (results[i++] ?? 0);
  const subscriptionPending =
    known?.type === "subscription" ? 0 : (results[i++] ?? 0);
  const subscriptionAwaiting =
    known?.type === "subscription" ? 0 : (results[i++] ?? 0);
  const nextCycle = known?.type === "subscription" ? 0 : (results[i++] ?? 0);
  const trial = known?.type === "trial" ? 0 : (results[i++] ?? 0);
  const counts: Record<InboxType, number> = {
    consultation:
      known?.type === "consultation"
        ? known.total
        : consultationPending + consultationAwaiting,
    subscription:
      known?.type === "subscription"
        ? known.total
        : subscriptionPending + subscriptionAwaiting + nextCycle,
    trial: known?.type === "trial" ? known.total : trial,
  };
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
  // Chip-filtered views don't reuse the cohort total for tab counts, so the
  // list scan and the tab counts are independent — run them together. The
  // default (no chip) view reuses its own total, so it stays sequential.
  if (args.chip) {
    const [rows, counts] = await Promise.all([
      readCohort(cp, scope, plan, now).then((cohort) =>
        sortInboxRows(cohort, args.sort),
      ),
      readCounts(cp, scope, now, null),
    ]);
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(1, args.page), pages);
    return toPlain({
      rows: rows.slice((page - 1) * limit, page * limit),
      meta: { total, page, limit, counts },
    });
  }
  const cohort = sortInboxRows(
    await readCohort(cp, scope, plan, now),
    args.sort,
  );
  const total = cohort.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, args.page), pages);
  const rows = cohort.slice((page - 1) * limit, page * limit);
  const counts = await readCounts(cp, scope, now, { type: args.type, total });
  return toPlain({ rows, meta: { total, page, limit, counts } });
}
