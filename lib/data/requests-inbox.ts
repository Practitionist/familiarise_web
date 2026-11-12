/**
 * The ONE read behind the consultant Requests inbox: the RSC page seeds
 * react-query with it, `/api/bookings/inbox` answers with it, and the Home
 * preview shows its first rows. Every row carries the input
 * `deriveBookingPresentation` (lib/dashboard/money-state.ts) reads, built the
 * way the payment history builds its own (lifecycleOf / planOf), so the inbox,
 * Home and the detail page cannot disagree about a booking.
 *
 * Sources per type: consultation and subscription requests in PENDING and
 * APPROVED_PENDING_PAYMENT (the needs-you predicates), subscriptions whose
 * live cycle is finished, trials in PENDING / AWAITING_PAYMENT, and unpaid
 * direct checkouts still inside their pay window (listed, never counted).
 * Chips narrow the sources server-side. A time sort over one source pages in
 * SQL by the request clock; every other view pages a bounded window sorted
 * here, because bucket and money are derived, not stored, and rows from
 * several sources cannot be merged at the column's precision.
 *
 * Auth stays with the caller: the route checks the session against
 * `consultantProfileId`, the page runs `requirePersonalProfileAccess`.
 */

import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { scopeToPlanHostWhere, type Scope } from "@/lib/api/scope/parse";
import { liveCheckoutHold } from "@/lib/booking/request-cohort";
import { liveReminderPayment } from "@/lib/booking/payment-reminder-eligibility";
import { mapLimit, poolLimit } from "@/lib/db/bounded";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { lifecycleOf, planOf } from "@/lib/appointments/presentation-input";
import { isSponsoredPayment } from "@/lib/appointments/payment-display";
import {
  soldSessionMinutes,
  soldTermsOf,
  subscriptionEntitlement,
  subscriptionPlanEnd,
  type SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { bookedSessionMinutes } from "@/lib/appointments/occurrences";
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
  INBOX_RANKED_WINDOW,
  INBOX_TYPES,
  decodeInboxCursor,
  encodeInboxCursor,
  inboxBucketOf,
  isCursorSort,
  sortInboxRows,
  toStampDate,
  type InboxBucket,
  type InboxChip,
  type InboxCursor,
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
  trialRequestWhere,
} from "@/lib/data/needs-you";
import { BUYER_PAYMENT_DISPLAY_SELECT } from "@/lib/data/payments-select";
import { toPlain } from "@/lib/data/serialize";
import { exactKeysetBand } from "@/lib/db/exact-keyset";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";

export interface ReadRequestsInboxArgs {
  consultantProfileId: string;
  /** Absent → personal (B2C), exactly as the list routes default. */
  orgScope?: Scope;
  type: InboxType;
  chip?: InboxChip;
  sort: InboxSort;
  page: number;
  /** Cursor sorts: the encoded last row of the previous page. */
  after?: string | null;
  /** Ranked sorts: open the page that holds this request. */
  focusId?: string | null;
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
    // #1760 — the EXPIRED edge tells a lapsed pay link from an unanswered
    // request. #1846 added the second arm: a consultant's withdraw-approval now
    // ends in CANCELLED rather than EXPIRED, so the `toStatus: "EXPIRED"` filter
    // alone would drop the edge that says WHO ended the booking. Added, not
    // substituted — the EXPIRED edge is still what proves a pay link lapsed, and
    // narrowing this select would silently un-prove it.
    statusHistory: {
      where: {
        OR: [
          { toStatus: "EXPIRED" as const },
          {
            toStatus: "CANCELLED" as const,
            reason: "WITHDRAWN_BY_CONSULTANT",
          },
        ],
      },
      select: { fromStatus: true, toStatus: true, reason: true },
    },
  },
};

const CONSULTATION_SELECT = {
  id: true,
  status: true,
  pendingPaymentUrl: true,
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
  requestedBy: {
    select: {
      ...PROFILE_WITH_USER_SELECT.select,
      user: {
        select: { ...PROFILE_WITH_USER_SELECT.select.user.select, email: true },
      },
    },
  },
  appointment: INBOX_APPOINTMENT_SELECT,
} satisfies Prisma.ConsultationSelect;

const SUBSCRIPTION_SELECT = {
  id: true,
  status: true,
  pendingPaymentUrl: true,
  requestedAt: true,
  bookingSource: true,
  requestNotes: true,
  schedulingPeriodStartsAt: true,
  schedulingPeriodEndsAt: true,
  schedulingTimezone: true,
  planEndsAt: true,
  sessionsTotal: true,
  sessionsPerWeek: true,
  sessionMinutes: true,
  sessionsRefunded: true,
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
  requestedBy: CONSULTATION_SELECT.requestedBy,
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

/** Where a page starts and which way it reads; every read is bounded by `take`. */
interface ReadWindow {
  dir: Prisma.SortOrder;
  after: InboxCursor | null;
  take: number;
}

/** `(requestedAt, id)` in one direction: a total order, so paging is stable. */
const orderOf = (dir: Prisma.SortOrder) => [{ requestedAt: dir }, { id: dir }];

/** Rows past the cursor row in the window's direction, at the column's microseconds. */
async function keysetWhere(
  table: "Consultation" | "Subscription" | "Trial",
  dir: Prisma.SortOrder,
  after: InboxCursor | null,
) {
  if (!after) return {};
  const band = await exactKeysetBand(table, dir, {
    id: after.id,
    at: after.requestedAt,
  });
  return {
    OR: [
      {
        requestedAt:
          dir === "asc" ? { gte: band.boundary } : { lt: band.boundary },
      },
      { id: { in: band.ids } },
    ],
  };
}

// Typed off the calls, not GetPayload: the read-path `$extends` hands money
// back as `number`, which GetPayload still spells `bigint`.
const findConsultations = async (
  where: Prisma.ConsultationWhereInput,
  w: ReadWindow,
) =>
  prisma.consultation.findMany({
    // No `deletedAt`: a request is retired by `status` + `cancelledAt`, both
    // written by the transition that closed it. See the Consultation model.
    where: {
      AND: [where, await keysetWhere("Consultation", w.dir, w.after)],
    },
    select: CONSULTATION_SELECT,
    orderBy: orderOf(w.dir),
    take: w.take,
  });
const findSubscriptions = async (
  where: Prisma.SubscriptionWhereInput,
  w: ReadWindow,
) =>
  prisma.subscription.findMany({
    where: {
      AND: [where, await keysetWhere("Subscription", w.dir, w.after)],
      deletedAt: null,
    },
    select: SUBSCRIPTION_SELECT,
    orderBy: orderOf(w.dir),
    take: w.take,
  });
const findTrials = async (where: Prisma.TrialWhereInput, w: ReadWindow) =>
  prisma.trial.findMany({
    where: { AND: [where, await keysetWhere("Trial", w.dir, w.after)] },
    select: TRIAL_SELECT,
    orderBy: orderOf(w.dir),
    take: w.take,
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

/** An unpaid direct checkout's pay window; null for anything else. */
function checkoutHoldOf(
  row: { status: string; bookingSource: string | null },
  a: AppointmentRow | null,
): InboxRowInput["checkoutHold"] {
  if (row.status !== "PENDING" || row.bookingSource !== "DIRECT_CHECKOUT") {
    return null;
  }
  if ((a?.payment ?? []).some((p) => p.paymentStatus === "SUCCEEDED")) {
    return null;
  }
  const expiresAt = pendingPayLinkDeadline(a);
  return expiresAt ? { expiresAt } : null;
}

/**
 * A request must be answered by the sooner of its own clock and its first
 * requested start less the booking lead time; past that point the requested
 * time can no longer be confirmed, only re-timed or declined.
 */
function requestUrgency(
  status: string,
  clock: Date | null,
  slots: { startsAt: Date; isTentative: boolean; completionStatus: string }[],
  now: Date,
): { deadline: Date | null; requestedStartPassed: boolean } {
  const firstStart = slots
    .filter((s) => s.isTentative && s.completionStatus === "SCHEDULED")
    .map((s) => toStampDate(s.startsAt).getTime())
    .sort((a, b) => a - b)[0];
  if (status !== "PENDING" || firstStart === undefined) {
    return { deadline: clock, requestedStartPassed: false };
  }
  const latest = new Date(firstStart - MINIMUM_BOOKING_LEAD_TIME_MS);
  return {
    deadline: clock && clock < latest ? clock : latest,
    requestedStartPassed: latest <= now,
  };
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
  const { bookingState, nextAction } = deriveBookingPresentation(
    row.presentation,
    "CONSULTANT",
    { now },
  );
  // A paid plan's clock is capture + 48 h, not the request hold; an open
  // proposal's clock is its own expiry, after which the original time stays.
  const openProposal =
    row.proposal?.status === "PENDING_REVIEW" ? row.proposal : null;
  const timed = openProposal
    ? { ...row, deadline: openProposal.expiresAt, requestedStartPassed: false }
    : nextAction.kind === "ALLOCATE" && nextAction.deadline
      ? { ...row, deadline: nextAction.deadline }
      : row;
  const isStrandedReschedule =
    row.kind === "consultation" &&
    bookingState.state !== "REQUESTED" &&
    row.rescheduledSlotCount > 0 &&
    row.proposal === null;
  const bucket: InboxBucket =
    openProposal?.initiatorRole === "CONSULTANT" &&
    openProposal.proposedTimes.length > 0
      ? "waiting-on-them"
      : isStrandedReschedule
        ? "answer-today"
        : inboxBucketOf(
            timed,
            bookingState.state,
            now,
            nextAction.kind === "ALLOCATE",
          );
  return { ...timed, bucket };
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
  const clock = pendingPayLinkDeadline(c.appointment) ?? holdDeadline;
  const checkoutHold = checkoutHoldOf(c, c.appointment);
  const { deadline, requestedStartPassed } = checkoutHold
    ? { deadline: checkoutHold.expiresAt, requestedStartPassed: false }
    : requestUrgency(c.status, clock, facts.slots, now);
  const presentation: BookingPresentationInput = {
    ...facts,
    request,
    holdExpiresAt: clock,
    plan: planOf({ consultation: c }),
    names: namesOf(c.requestedBy, c.consultationPlan.consultantProfile),
  };
  return finish(
    {
      id: c.id,
      kind: "consultation",
      appointmentId: c.appointment?.id ?? null,
      reminderExpiresAt: liveReminderPayment(c, now)?.expiresAt ?? null,
      planTitle: c.consultationPlan.title,
      requester: {
        name: c.requestedBy.user.name ?? "Learner",
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
        Math.ceil(
          (bookedSessionMinutes(c.appointment?.occurrences ?? []) ??
            (c.consultationPlan.durationInHours || 1) * 60) /
            60 /
            SLOT_HOURS,
        ),
      ),
      tentativeSlotCount: facts.tentativeSlotCount,
      rescheduledSlotCount: facts.rescheduledSlotCount,
      proposal: facts.proposal,
      schedulingPeriod: null,
      schedulingTimezone: null,
      entitlement: null,
      trial: null,
      checkoutHold,
      requestedStartPassed,
    },
    now,
  );
}

/** The fields the entitlement needs; the slim next-cycle count reads only these. */
const ENTITLEMENT_SELECT = {
  id: true,
  requestedAt: true,
  sessionsTotal: true,
  sessionsPerWeek: true,
  sessionsRefunded: true,
  schedulingPeriodStartsAt: true,
  schedulingTimezone: true,
  planEndsAt: true,
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
  const terms = soldTermsOf(s);
  if (terms.sessionsTotal <= 0 || !s.schedulingPeriodStartsAt) return null;
  return subscriptionEntitlement({
    ...terms,
    occurrences: (s.appointment?.occurrences ?? []).map((o) => ({
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      completionStatus: o.completionStatus,
      isTentative: o.isTentative,
      deletedAt: o.deletedAt,
    })),
    schedulingPeriodStartsAt: s.schedulingPeriodStartsAt,
    schedulingTimezone: s.schedulingTimezone,
    planEndsAt: s.planEndsAt,
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
  const clock =
    kind === "next-cycle"
      ? (entitlement?.cycle.windowStart ?? null)
      : (pendingPayLinkDeadline(s.appointment) ?? holdDeadline);
  const checkoutHold =
    kind === "next-cycle" ? null : checkoutHoldOf(s, s.appointment);
  const { deadline, requestedStartPassed } = checkoutHold
    ? { deadline: checkoutHold.expiresAt, requestedStartPassed: false }
    : requestUrgency(s.status, clock, facts.slots, now);
  const presentation: BookingPresentationInput = {
    ...facts,
    request,
    holdExpiresAt: kind === "next-cycle" ? null : clock,
    plan: planOf({ subscription: s }),
    names: namesOf(s.requestedBy, s.subscriptionPlan.consultantProfile),
  };
  const slotsPerSession = Math.max(
    1,
    Math.ceil(soldSessionMinutes(s) / 60 / SLOT_HOURS),
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
      reminderExpiresAt: liveReminderPayment(s, now)?.expiresAt ?? null,
      planTitle: s.subscriptionPlan.title,
      requester: {
        name: s.requestedBy.user.name ?? "Learner",
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
        end: subscriptionPlanEnd(s),
      },
      schedulingTimezone: s.schedulingTimezone,
      entitlement,
      trial: null,
      checkoutHold,
      requestedStartPassed,
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
      reminderExpiresAt: null,
      planTitle: t.subscriptionPlan.title,
      requester: {
        name: t.consulteeProfile.user.name ?? "Learner",
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
      trial: {
        durationMinutes: t.subscriptionPlan.trialDurationMinutes,
        consulteeUserId: t.consulteeProfile.user.id,
      },
      checkoutHold: null,
      requestedStartPassed: false,
    },
    now,
  );
}

const PERSONAL: Scope = { kind: "personal" };

const CONSULTATION_HOLD_MS = 48 * HOUR_MS;
const SUBSCRIPTION_HOLD_MS = 30 * DAY_MS;

/**
 * "Answer today" server-side, the same rule the bucket applies: the hold has
 * under 24 h left, or the first requested time is within 24 h plus the lead.
 */
function answerToday(holdMs: number, now: Date) {
  return {
    OR: [
      { requestedAt: { lte: new Date(now.getTime() - (holdMs - DAY_MS)) } },
      {
        appointment: {
          occurrences: {
            some: {
              isTentative: true,
              completionStatus: "SCHEDULED" as const,
              deletedAt: null,
              startsAt: {
                lte: new Date(
                  now.getTime() + DAY_MS + MINIMUM_BOOKING_LEAD_TIME_MS,
                ),
              },
            },
          },
        },
      },
    ],
  };
}

/**
 * An APPROVED consultation whose whole-booking reschedule ended (declined or
 * expired) after its original time was claimed by another booking: its only
 * occurrences are still `RESCHEDULED`, no live confirmed session exists, and
 * no `PENDING_REVIEW` proposal remains open. Surface it in the Requests inbox
 * so the consultant can allocate a replacement slot.
 */
function strandedApprovedConsultationWhere(
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
 * One list the inbox reads. `onTab` sources make up the tab label; a live
 * checkout hold is listed for context but never counted anywhere.
 */
interface InboxSource {
  onTab: boolean;
  count: () => Promise<number>;
  read: (w: ReadWindow) => Promise<InboxRowInput[]>;
}

function consultationSource(
  cp: string,
  where: Prisma.ConsultationWhereInput,
  now: Date,
  onTab = true,
): InboxSource {
  return {
    onTab,
    count: () => prisma.consultation.count({ where }),
    read: async (w) =>
      (await findConsultations(where, w)).map((c) =>
        consultationRow(c, cp, now),
      ),
  };
}

function subscriptionSource(
  cp: string,
  where: Prisma.SubscriptionWhereInput,
  now: Date,
  onTab = true,
): InboxSource {
  return {
    onTab,
    count: () =>
      prisma.subscription.count({ where: { ...where, deletedAt: null } }),
    read: async (w) =>
      (await findSubscriptions(where, w)).map((s) =>
        subscriptionRow(s, cp, now, "subscription"),
      ),
  };
}

/** Candidates one next-cycle read pulls before the `remaining > 0` filter. */
const NEXT_CYCLE_BATCH = INBOX_RANKED_WINDOW;
/** The tab count reads at most this many candidates, in batches. */
const NEXT_CYCLE_COUNT_CAP = 10 * NEXT_CYCLE_BATCH;

/**
 * `remaining > 0` is derived (frozen entitlement minus delivered and held
 * sessions), so SQL cannot filter or count it. Both the read and the count
 * walk the candidates in keyset order and filter each batch: a page never
 * skips a survivor past a filtered batch, and the count is exact up to
 * NEXT_CYCLE_COUNT_CAP candidates.
 */
function nextCycleSource(cp: string, scope: Scope, now: Date): InboxSource {
  const where = nextCycleSubscriptionWhere(cp, scope);
  return {
    onTab: true,
    count: async () => {
      let after: InboxCursor | null = null;
      let survivors = 0;
      for (
        let read = 0;
        read < NEXT_CYCLE_COUNT_CAP;
        read += NEXT_CYCLE_BATCH
      ) {
        const batch: EntitlementRow[] = await prisma.subscription.findMany({
          where: {
            AND: [where, await keysetWhere("Subscription", "asc", after)],
          },
          select: ENTITLEMENT_SELECT,
          orderBy: orderOf("asc"),
          take: NEXT_CYCLE_BATCH,
        });
        survivors += batch.filter(
          (s) => (entitlementOf(s, now)?.remaining ?? 0) > 0,
        ).length;
        const last = batch[batch.length - 1];
        if (batch.length < NEXT_CYCLE_BATCH || !last) break;
        after = { requestedAt: last.requestedAt, id: last.id };
      }
      return survivors;
    },
    read: async (w) => {
      const rows: InboxRowInput[] = [];
      let after = w.after;
      for (;;) {
        const batch = await findSubscriptions(where, {
          ...w,
          after,
          take: NEXT_CYCLE_BATCH,
        });
        rows.push(
          ...batch
            .map((s) => subscriptionRow(s, cp, now, "next-cycle"))
            .filter((row) => (row.entitlement?.remaining ?? 0) > 0),
        );
        const last = batch[batch.length - 1];
        if (batch.length < NEXT_CYCLE_BATCH || !last || rows.length >= w.take) {
          return rows;
        }
        after = { requestedAt: last.requestedAt, id: last.id };
      }
    },
  };
}

function trialSource(
  cp: string,
  where: Prisma.TrialWhereInput,
  now: Date,
): InboxSource {
  return {
    onTab: true,
    count: () => prisma.trial.count({ where }),
    read: async (w) =>
      (await findTrials(where, w)).map((t) => trialRow(t, cp, now)),
  };
}

type ChipKey = InboxChip | "all";

/** The sources a (type, chip) pair reads; a chip the tab lacks reads nothing. */
function planSources(
  cp: string,
  scope: Scope,
  type: InboxType,
  chip: InboxChip | undefined,
  now: Date,
): InboxSource[] {
  const key: ChipKey = chip ?? "all";
  if (type === "consultation") {
    const pending = pendingConsultationWhere(cp, scope);
    const stranded = consultationSource(
      cp,
      strandedApprovedConsultationWhere(cp, scope),
      now,
    );
    const awaiting = consultationSource(
      cp,
      consultationRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
      now,
    );
    const byChip: Partial<Record<ChipKey, InboxSource[]>> = {
      all: [
        consultationSource(cp, pending, now),
        stranded,
        awaiting,
        consultationSource(
          cp,
          {
            AND: [
              consultationRequestWhere(cp, scope, "PENDING"),
              liveCheckoutHold(now),
            ],
          },
          now,
          false,
        ),
      ],
      "answer-today": [
        consultationSource(
          cp,
          { AND: [pending, answerToday(CONSULTATION_HOLD_MS, now)] },
          now,
        ),
        stranded,
      ],
      "awaiting-payment": [awaiting],
      declined: [
        consultationSource(
          cp,
          consultationRequestWhere(cp, scope, "REJECTED"),
          now,
        ),
      ],
    };
    return byChip[key] ?? [];
  }
  if (type === "subscription") {
    const pending = pendingSubscriptionWhere(cp, scope);
    const awaiting = subscriptionSource(
      cp,
      subscriptionRequestWhere(cp, scope, "APPROVED_PENDING_PAYMENT"),
      now,
    );
    const nextCycle = nextCycleSource(cp, scope, now);
    const byChip: Partial<Record<ChipKey, InboxSource[]>> = {
      all: [
        subscriptionSource(cp, pending, now),
        awaiting,
        nextCycle,
        subscriptionSource(
          cp,
          {
            AND: [
              subscriptionRequestWhere(cp, scope, "PENDING"),
              liveCheckoutHold(now),
            ],
          },
          now,
          false,
        ),
      ],
      "answer-today": [
        subscriptionSource(
          cp,
          { AND: [pending, answerToday(SUBSCRIPTION_HOLD_MS, now)] },
          now,
        ),
      ],
      "awaiting-payment": [awaiting],
      "next-cycle": [nextCycle],
      declined: [
        subscriptionSource(
          cp,
          subscriptionRequestWhere(cp, scope, "REJECTED"),
          now,
        ),
      ],
    };
    return byChip[key] ?? [];
  }
  // A trial has no hold clock, so "answer today" is every pending one.
  const trialStatuses: Partial<
    Record<ChipKey, ("PENDING" | "AWAITING_PAYMENT" | "REJECTED")[]>
  > = {
    all: ["PENDING", "AWAITING_PAYMENT"],
    "answer-today": ["PENDING"],
    "awaiting-payment": ["AWAITING_PAYMENT"],
    declined: ["REJECTED"],
  };
  const statuses = trialStatuses[key];
  return statuses
    ? [trialSource(cp, trialRequestWhere(cp, scope, statuses), now)]
    : [];
}

function bucketTotalsOf(rows: InboxRowInput[]): Record<InboxBucket, number> {
  const totals: Record<InboxBucket, number> = {
    "answer-today": 0,
    "this-week": 0,
    later: 0,
    "waiting-on-them": 0,
  };
  for (const row of rows) totals[row.bucket] += 1;
  return totals;
}

export async function readRequestsInbox(
  args: ReadRequestsInboxArgs,
): Promise<RequestsInboxPayload> {
  const now = args.now ?? new Date();
  const scope = args.orgScope ?? PERSONAL;
  const limit = args.limit ?? INBOX_DEFAULT_LIMIT;
  const cp = args.consultantProfileId;
  const sources = planSources(cp, scope, args.type, args.chip, now);
  // One source pages in its own SQL order; several are merged in a window.
  const cursorPaged = isCursorSort(args.sort) && sources.length === 1;
  const dir: Prisma.SortOrder = args.sort === "new" ? "desc" : "asc";
  const window: ReadWindow = cursorPaged
    ? { dir, after: decodeInboxCursor(args.after), take: limit + 1 }
    : { dir, after: null, take: INBOX_RANKED_WINDOW };

  // Tab labels count each type's default view with the sources it lists; the
  // default view's total adds the uncounted holds. Every count and read runs
  // in ONE pool-bounded queue, so the inbox never exceeds poolLimit().
  const counts: Record<InboxType, number> = {
    consultation: 0,
    subscription: 0,
    trial: 0,
  };
  let extra = 0;
  const listed: InboxRowInput[] = [];
  const tasks: (() => Promise<void>)[] = [
    ...INBOX_TYPES.flatMap((type) =>
      planSources(cp, scope, type, undefined, now)
        .filter((source) => source.onTab)
        .map((source) => async () => {
          // Await first: `+= await` reads the old total before the await.
          const n = await source.count();
          counts[type] += n;
        }),
    ),
    ...(args.chip ? sources : sources.filter((s) => !s.onTab)).map(
      (source) => async () => {
        const n = await source.count();
        extra += n;
      },
    ),
    ...sources.map((source) => async () => {
      listed.push(...(await source.read(window)));
    }),
  ];
  await mapLimit(tasks, poolLimit(), (run) => run());
  const total = args.chip ? extra : counts[args.type] + extra;

  if (cursorPaged) {
    // Already in the source's SQL order; a JS re-sort would drop microseconds.
    const rows = listed.slice(0, limit);
    const last = rows[rows.length - 1];
    return toPlain({
      rows,
      meta: {
        total,
        limit,
        counts,
        paging: "cursor",
        nextCursor:
          listed.length > limit && last ? encodeInboxCursor(last) : null,
        page: 1,
        windowSize: rows.length,
        bucketTotals: null,
      },
    });
  }

  // Ranked: each source's window is its oldest rows (the nearest their
  // clocks), or its newest for the newest-first sort.
  const ranked = sortInboxRows(listed, args.sort).slice(0, INBOX_RANKED_WINDOW);
  const pages = Math.max(1, Math.ceil(ranked.length / limit));
  const focusAt = args.focusId
    ? ranked.findIndex((row) => row.id === args.focusId)
    : -1;
  const page =
    focusAt >= 0
      ? Math.floor(focusAt / limit) + 1
      : Math.min(Math.max(1, args.page), pages);
  return toPlain({
    rows: ranked.slice((page - 1) * limit, page * limit),
    meta: {
      total,
      limit,
      counts,
      paging: "ranked",
      nextCursor: null,
      page,
      windowSize: ranked.length,
      bucketTotals: bucketTotalsOf(ranked),
    },
  });
}
