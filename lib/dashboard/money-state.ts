/**
 * #1675 / #1586 P1-J07/J08 / #1527 W2 — the ONE derivation every dashboard
 * surface reads a booking through: what it is, which single state it is in,
 * what this viewer does next. Before this module every surface read enums off
 * the rows, so one page said "Pending", "HELD · AWAITING PAYMENT" and "No
 * payment is attached" about the same booking at once.
 *
 * Pure and Prisma-free (prisma → pg → fs breaks a client import), so the
 * detail page, the checkout success route and the Home widget all call it and
 * a jest pin runs it without a client. The refund half reuses
 * `lib/appointments/seat-payments.ts`; the rail/receipt half reuses
 * `lib/appointments/payment-display.ts`. Nothing here decides legality —
 * `lib/booking/transitions.ts` owns that; this only names what the rows say.
 */

import { formatInViewerZone } from "@/lib/time/viewer-zone";
import type { StatusBadgeStyle } from "@/lib/labels/session-labels";
import { toneClass, type Tone } from "@/lib/ui/tone";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  REJOIN_GRACE_MS,
  isDeadOccurrence,
  isDeliberateEnd,
  isOccurrenceHeld,
} from "@/lib/appointments/occurrences";
import { isCompletedOccurrence } from "@/lib/booking/entitlement";
import { normalizeStatus } from "@/lib/appointments/status";
import { paymentDisplayStatus } from "@/lib/appointments/seat-payments";
import {
  isSponsoredPayment,
  isFreePayment,
  paymentFunding,
  paymentRailLabel,
  type PaymentDisplayLike,
} from "@/lib/appointments/payment-display";
import { formatCurrencyAmount } from "@/utils/formatting";
import { PLAN_END_REFUND_REASON } from "@/lib/payments/refund-reasons";
import {
  paymentsLapsed,
  unpaidLinkSeen,
} from "@/lib/appointments/list-status-facts";
import {
  BOOKING_STAGES,
  bookingStatus,
  expertApproval,
  requestedAgainEdge,
  type BookingStage,
  type BookingStatusFacts,
  type HistoryEdgeInput,
  type OpenRescheduleInput,
} from "@/lib/appointments/booking-status";

export type { HistoryEdgeInput, OpenRescheduleInput };

export type Viewer = "CONSULTANT" | "CONSULTEE" | "ORG_ADMIN";

// The tones moved to lib/ui/tone.ts (#1527); re-exported so importers keep working.
export { TONE_CLASS, type Tone } from "@/lib/ui/tone";

export const BOOKING_STATE_KINDS = BOOKING_STAGES;
export type BookingStateKind = BookingStage;

export const MONEY_STATE_KINDS = [
  "NOT_DUE",
  "DUE",
  "PAID",
  "REFUND_PENDING",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "SPONSORED",
  "DISPUTED",
  "FREE",
] as const;
export type MoneyStateKind = (typeof MONEY_STATE_KINDS)[number];

export type NextActionKind =
  | "APPROVE_OR_DECLINE"
  /** #1775 — the consultant's actions on an unpaid approval. */
  | "REMIND_OR_WITHDRAW"
  /** #1775 C-5 — a paid plan waiting for cycle 1, or for its next cycle. */
  | "ALLOCATE"
  /** #1780 row 6 — the host's misses give the learner a full-refund exit. */
  | "EXIT_SERIES"
  /** The other side's proposed new times wait on this viewer. */
  | "RESPOND_TO_MOVE"
  | "PAY"
  | "REQUEST_AGAIN"
  | "JOIN"
  | "RATE"
  | "NONE";

export interface BookingState {
  state: BookingStateKind;
  label: string;
  tone: Tone;
  /** One sentence for the viewer, never a second state word. */
  why: string;
}

export interface MoneyState {
  state: MoneyStateKind;
  label: string;
  tone: Tone;
  /** The ONE money line: `₹X · rail · date`, `Sponsored by <Org>`, … */
  line: string;
  /** An optional second, quieter line (the plan arithmetic, a co-pay). */
  detail?: string;
}

export interface NextAction {
  kind: NextActionKind;
  label: string;
  deadline?: Date;
}

export interface TimelineEvent {
  /** Null for a step that has not happened (and for one whose clock the read does not carry). */
  at: Date | null;
  actor: string;
  label: string;
  done: boolean;
  /** #1780 — the refund leg a refund event shows; absent on every other step. */
  kind?: RefundTimelineKind;
}

export type RefundTimelineKind =
  | "refund-requested"
  | "refund-processing"
  | "refund-completed"
  | "refund-failed";

export type OccurrenceInput = {
  id?: string;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  isTentative: boolean;
  completionStatus?: string | null;
  outcome?: string | null;
  deletedAt?: Date | string | null;
  meeting?: {
    endedAt: Date | string | null;
    endedReason?: string | null;
  } | null;
};

export type PaymentInput = PaymentDisplayLike & {
  amount: bigint | number | string;
  taxAmount?: bigint | number | string | null;
  currency: string;
  createdAt: Date | string;
  expiresAt?: Date | string | null;
  /** #1775 C-2 — the capture clock; a read without it falls back to createdAt. */
  capturedAt?: Date | string | null;
  /** False only for a pre-mint placeholder no gateway ever saw; absent reads as minted. */
  gatewayOrderMinted?: boolean;
};

export type RefundInput = {
  amountPaise: bigint | number | string;
  status: string;
  /** #1780 — the gateway's refund id once it has one; a placeholder before. */
  refundId?: string | null;
  /** Who wrote it and why (`PLAN_END_REFUND_REASON` for an ended plan's unused sessions). */
  reason?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type DisputeInput = { status: string };

export interface BookingPresentationInput {
  appointmentType: string;
  /**
   * The lifecycle row: a Consultation/Subscription request, a Webinar/Class
   * event or a Trial. `kind` names the enum family the status comes from.
   */
  request: {
    status: string | null | undefined;
    kind: string;
    /** The hold clock: a reschedule restarts it, so it is not when the booking was made. */
    requestedAt?: Date | string | null;
    /** When the booking was made (the row's creation). */
    bookedAt?: Date | string | null;
  } | null;
  occurrences: OccurrenceInput[];
  /** The booking's own Payment rows (an attendee's own seat on a group event). */
  payments: PaymentInput[];
  /** Every refund against those rows, PENDING and SUCCEEDED alike. */
  refunds: RefundInput[];
  disputes: DisputeInput[];
  /** CHARGE_MEMBER co-pay rows the viewer paid themselves (#775). */
  childPayments: PaymentInput[];
  sponsorOrgName: string | null;
  /** When the held slots or the pay link release; null when nothing is held. */
  holdExpiresAt: Date | string | null;
  /**
   * #1760 — the EXPIRED history edge tells a lapsed pay link apart from a
   * request nobody answered. Optional: a read without history falls back to
   * "a pay link was minted".
   *
   * `reason` is the audit attribution the transition wrote (lib/booking/
   * transitions.ts `HistoryMeta.reason`), and it is the only thing that
   * distinguishes the several writers of one terminal status — CANCELLED is
   * written by the buyer's abandon, by a decline's restore and by the
   * consultant's withdraw-approval alike. A reader that selects `fromStatus`
   * and `toStatus` without it cannot tell them apart, which is why the readers
   * widen their `where` as well as their `select` where a reason matters.
   */
  history?: HistoryEdgeInput[];
  /** Sessions parked for ops, counted by the reader with `AWAITING_HUMAN`. */
  parkedSessions?: number;
  /** How the booking began: a pay-first checkout hold or a submitted request. */
  source?: string | null;
  /** The open reschedule proposal; null when none is open. */
  reschedule?: OpenRescheduleInput | null;
  /** The viewer's own seat on a webinar or class; null for a host or a 1:1. */
  seatStatus?: string | null;
  /** Plan price for the not-due arithmetic line; null when the read lacks it. */
  plan?: {
    pricePaise: bigint | number | string;
    currency: string;
    sessions: number;
  } | null;
  names: { payer: string; consultant: string };
  /** #1775 C-5 — a subscription's entitlement summary (lib/booking/entitlement). */
  entitlement?: {
    remaining: number;
    nextBatch: number;
    /** Sessions of the plan that were never delivered. */
    notHeld?: number;
    /** The plan's end has passed. */
    planEnded?: boolean;
  } | null;
  /** #1780 E-5 — a class seat's series ledger summary. */
  series?: {
    misses: number;
    N: number;
    exitRight: boolean;
    undelivered: number;
  } | null;
}

export interface BookingPresentation {
  bookingState: BookingState;
  moneyState: MoneyState;
  nextAction: NextAction;
  timeline: TimelineEvent[];
  /** Schedule words only for a Sessions row — never a money word. */
  sessionRowLabel: (occurrence: OccurrenceInput) => string;
  /**
   * #1675 — the header's one session-count story: "<held> of <plan> sessions
   * scheduled" once the plan size is known, else the bare held count. The
   * header uses this for SUBSCRIPTION/CLASS instead of a second, conflicting
   * count next to the money line.
   */
  sessionProgress: string;
  /**
   * #1752 — false while the money is in but the rows are still tentative: the
   * confirmation pipeline has not landed, so the success page keeps polling.
   */
  settled: boolean;
}

export interface DeriveOptions {
  now?: Date;
  /** How early before `startsAt` a session counts as joinable. */
  joinWindowMs?: number;
  /** The viewer's profile zone (`ViewerZone.zone`); every printed time reads in it. */
  viewerZone: string;
  /** Sessions the server says this viewer attended (the rating gate). */
  heldOccurrenceIds?: ReadonlySet<string>;
}

const toDate = (v: Date | string): Date =>
  v instanceof Date ? v : new Date(v);
const toDateOrNull = (v: Date | string | null | undefined): Date | null =>
  v === null || v === undefined ? null : toDate(v);

// PENDING requests expire in expire-stale-requests.ts (48 h consultation,
// 30 d subscription); the held slots release with them. Mirrored, not
// imported: that script loads Prisma.
const REQUEST_HOLD_MS: Record<string, number> = {
  CONSULTATION: 48 * 60 * 60 * 1000,
  SUBSCRIPTION: 30 * 24 * 60 * 60 * 1000,
};

/** The deadline a PENDING request's held slots release at. */
export function requestHoldDeadline(
  kind: string,
  requestedAt: Date | string | null | undefined,
): Date | null {
  const ms = REQUEST_HOLD_MS[normalizeStatus(kind)];
  if (!ms || !requestedAt) return null;
  return new Date(toDate(requestedAt).getTime() + ms);
}

// #1775 C-3 — a paid plan's cycle 1 must be allocated within 48 h of capture.
// Mirrored, not imported: expire-stale-requests.ts loads Prisma.
export const ALLOCATE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** capturedAt (or createdAt) of the settled payment + 48 h; null when unpaid. */
export function allocateDeadline(
  payments: BookingPresentationInput["payments"],
): Date | null {
  const paid = payments.find((x) => x.paymentStatus === "SUCCEEDED");
  if (!paid) return null;
  const clock = toDate(paid.capturedAt ?? paid.createdAt);
  return new Date(clock.getTime() + ALLOCATE_WINDOW_MS);
}

/** #1775 C-5 — the plan's paid cycle 1, or its next cycle, awaits the consultant. */
function allocationWait(
  input: BookingPresentationInput,
  live: OccurrenceInput[],
  paid: boolean,
  now: Date,
): "CYCLE_1" | "NEXT_CYCLE" | null {
  if (normalizeStatus(input.appointmentType) !== "SUBSCRIPTION") return null;
  const status = normalizeStatus(input.request?.status);
  if (status === "PENDING" && paid && live.length === 0) return "CYCLE_1";
  const upcoming = live.some((o) => occurrenceEnd(o) >= now.getTime());
  // Only while a plan week is open to place into: never "schedule the next 0".
  if (
    status === "APPROVED" &&
    !upcoming &&
    (input.entitlement?.remaining ?? 0) > 0 &&
    (input.entitlement?.nextBatch ?? 0) > 0
  )
    return "NEXT_CYCLE";
  return null;
}
/**
 * A plan that ended with sessions never delivered says so, before and after
 * the plan-end sweep, with the settlement's stored refund when there is one;
 * null when the plan was fully held or has not ended.
 */
function planEndedShortWhy(input: BookingPresentationInput): string | null {
  const e = input.entitlement;
  if (!e?.planEnded || !e.notHeld) return null;
  const head = `Plan ended · ${
    e.notHeld === 1 ? "1 session was" : `${e.notHeld} sessions were`
  } not held.`;
  const settled = input.refunds.filter(
    (r) => r.reason === PLAN_END_REFUND_REASON,
  );
  const sum = (status: string) =>
    settled
      .filter((r) => r.status === status)
      .reduce((total, r) => total + Number(r.amountPaise), 0);
  const currency =
    input.payments.find((p) => p.paymentStatus === "SUCCEEDED")?.currency ??
    "INR";
  const refunded = sum("SUCCEEDED");
  if (refunded > 0) return `${head} ${money(refunded, currency)} refunded.`;
  const onItsWay = sum("PENDING");
  if (onItsWay > 0) {
    return `${head} ${money(onItsWay, currency)} refund on its way.`;
  }
  return head;
}
/** Stored statuses a late capture still confirms, while the booked time is free. */
const CAPTURE_CAN_CONFIRM = new Set([
  "PENDING",
  "APPROVED_PENDING_PAYMENT",
  "AWAITING_PAYMENT",
]);
const OPEN_DISPUTES = new Set([
  "WARNING_NEEDS_RESPONSE",
  "WARNING_UNDER_REVIEW",
  "NEEDS_RESPONSE",
  "UNDER_REVIEW",
]);

const MONEY_TONE: Record<MoneyStateKind, Tone> = {
  NOT_DUE: "neutral",
  DUE: "warning",
  PAID: "success",
  REFUND_PENDING: "info",
  REFUNDED: "neutral",
  PARTIALLY_REFUNDED: "info",
  SPONSORED: "info",
  DISPUTED: "critical",
  FREE: "neutral",
};

/** `StatusBadge` props for a tone + label. */
export function toneBadge(tone: Tone, label: string): StatusBadgeStyle {
  return { label, ...toneClass(tone) };
}

const money = (paise: bigint | number | string, currency: string) =>
  formatCurrencyAmount(Number(paise), currency);
const defaultViewerZone = () =>
  (typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : undefined) ?? "UTC";
const day = (d: Date, zone?: string | null) =>
  formatInViewerZone(d, zone ?? defaultViewerZone(), "EEE d MMM");
const dayTime = (d: Date, zone?: string | null) =>
  formatInViewerZone(d, zone ?? defaultViewerZone(), "EEE d MMM HH:mm");

function occurrenceEnd(o: OccurrenceInput): number {
  return (
    toDateOrNull(o.endsAt) ??
    new Date(toDate(o.startsAt).getTime() + 60 * 60 * 1000)
  ).getTime();
}

function isOccurrencePastGrace(o: OccurrenceInput, now: Date): boolean {
  if (isDeliberateEnd(o.meeting)) return true;
  const status = normalizeStatus(o.completionStatus);
  if (status === "COMPLETED" || status === "VOIDED") {
    return occurrenceEnd(o) < now.getTime();
  }
  const graceMs = o.endsAt ? REJOIN_GRACE_MS : 0;
  return occurrenceEnd(o) + graceMs < now.getTime();
}

/** Held / Released / Scheduled / Completed / Cancelled — the schedule words. */
function rowLabel(
  o: OccurrenceInput,
  booking: BookingStateKind,
  holdExpiresAt: Date | null,
  now: Date,
  payFirst: boolean,
): string {
  if (o.deletedAt || normalizeStatus(o.completionStatus) === "CANCELLED")
    return "Cancelled";
  if (normalizeStatus(o.completionStatus) === "RESCHEDULED") return "Released";
  if (o.isTentative) {
    // A pay-first hold is the learner's own checkout; only an approval sends a link.
    if (booking === "AWAITING_PAYMENT")
      return payFirst ? "Held" : "Held · link sent";
    if (
      booking === "PAYMENT_LAPSED" ||
      booking === "CANCELLED" ||
      booking === "DECLINED"
    )
      return "Released";
    if (!holdExpiresAt || holdExpiresAt <= now) return "Held";
    const hours = Math.floor(
      (holdExpiresAt.getTime() - now.getTime()) / 3_600_000,
    );
    return hours >= 24
      ? `Held · ${Math.floor(hours / 24)}d`
      : `Held · ${Math.max(hours, 1)}h`;
  }
  return isOccurrencePastGrace(o, now) ? "Completed" : "Scheduled";
}

const paidOf = (input: BookingPresentationInput) =>
  input.payments.find((x) => x.paymentStatus === "SUCCEEDED");

/** The stored facts the one status function reads, from the presentation input. */
function statusFacts(
  input: BookingPresentationInput,
  live: OccurrenceInput[],
  paid: boolean,
  now: Date,
  held?: ReadonlySet<string>,
): BookingStatusFacts {
  const paidRow = paidOf(input);
  const landed =
    paidRow && !isFreePayment(paidRow)
      ? input.refunds.filter((r) => normalizeStatus(r.status) === "SUCCEEDED")
      : [];
  // Completed by evidence, never by the clock: a recorded outcome, the host
  // ending the call, the viewer's attendance (the rating gate) or the plan's end.
  const done =
    live.length > 0 &&
    (!!input.entitlement?.planEnded ||
      live.every(
        (o) =>
          isOccurrenceHeld(o) ||
          isDeliberateEnd(o.meeting) ||
          (!!o.id && !!held?.has(o.id)),
      ));
  const landedAt = landed
    .map((r) => toDateOrNull(r.updatedAt ?? r.createdAt))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    kind: input.request?.kind || input.appointmentType,
    status: input.request?.status,
    source: input.source,
    seatStatus: input.seatStatus,
    paid,
    payDeadline: input.holdExpiresAt,
    payLapsed: paymentsLapsed(input.payments),
    unpaidLinkSeen: unpaidLinkSeen(input.payments),
    reschedule: input.reschedule,
    refunded:
      landed.length > 0 && paidRow
        ? {
            paise: landed.reduce((t, r) => t + Number(r.amountPaise), 0),
            currency: paidRow.currency,
            at: landedAt ?? null,
          }
        : null,
    sessions: {
      live: live.length,
      allTentative: live.length > 0 && live.every((o) => o.isTentative),
      done,
      awaitingOutcome:
        !done &&
        live.length > 0 &&
        live.every((o) => isOccurrencePastGrace(o, now)),
    },
    planEnded: !!input.entitlement?.planEnded,
    planWait: allocationWait(input, live, paid, now),
    allocateBy: allocateDeadline(input.payments),
    nextBatch: input.entitlement?.nextBatch ?? 0,
    history: input.history,
    parkedSessions: input.parkedSessions,
    completedNote: planEndedShortWhy(input),
    names: input.names,
  };
}

/**
 * An open order means the buyer is paying now, so a request with one is not
 * "not due": it is due while its window is open and lapsed once it closes.
 */
function moneyStage(
  input: BookingPresentationInput,
  booking: BookingStateKind,
  now: Date,
): BookingStateKind {
  const open = input.payments.find((x) => x.paymentStatus === "PENDING");
  if (booking !== "REQUESTED" || !open) return booking;
  const closes = toDateOrNull(open.expiresAt);
  return closes && closes <= now ? "PAYMENT_LAPSED" : "AWAITING_PAYMENT";
}

function deriveMoney(
  input: BookingPresentationInput,
  booking: BookingStateKind,
  viewer: Viewer,
  holdExpiresAt: Date | null,
  now: Date,
  zone?: string | null,
): MoneyState {
  const c = input.names.consultant;
  const p = input.names.payer;
  const you = viewer === "CONSULTEE";
  const paid = input.payments.find((x) => x.paymentStatus === "SUCCEEDED");
  const pending = input.payments.find((x) => x.paymentStatus === "PENDING");
  // A gateway order that existed can still capture late, and that capture is
  // refunded; only rows that never reached a gateway prove nothing was charged.
  const unpaid = input.payments.filter((x) => x.paymentStatus !== "SUCCEEDED");
  const mayHaveCharged = unpaid.some((x) => x.gatewayOrderMinted !== false);
  const declined =
    unpaid.length > 0 && unpaid.every((x) => x.paymentStatus === "FAILED");
  const chargedWho = you ? "you were" : `${p} was`;
  const ifCharged = `If ${chargedWho} charged, the money is refunded automatically.`;
  // Only an EXPIRED or FAILED order, or a booking that has ended, refunds a late
  // capture; a PENDING order on an open booking confirms it instead.
  const lateCaptureMayConfirm =
    !!pending &&
    pending.gatewayOrderMinted !== false &&
    (CAPTURE_CAN_CONFIRM.has(normalizeStatus(input.request?.status)) ||
      normalizeStatus(input.seatStatus) === "HELD");
  // A CHARGE_ORG overage child is the organisation's charge, never a co-pay.
  const coPay = input.childPayments.filter(
    (x) => x.paymentStatus === "SUCCEEDED" && !isSponsoredPayment(x),
  );
  const coPayLine =
    coPay.length > 0
      ? ` + ${money(
          coPay.reduce((s, x) => s + Number(x.amount), 0),
          coPay[0].currency,
        )} co-pay`
      : "";
  const build = (
    state: MoneyStateKind,
    label: string,
    line: string,
    detail?: string,
  ): MoneyState => ({
    state,
    label,
    tone: MONEY_TONE[state],
    line,
    ...(detail ? { detail } : {}),
  });

  if (paid) {
    const rail = paymentRailLabel(paid);
    const when = formatInViewerZone(
      toDate(paid.createdAt),
      zone ?? defaultViewerZone(),
      "d MMM yyyy",
    );
    if (
      input.disputes.some((d) => OPEN_DISPUTES.has(normalizeStatus(d.status)))
    ) {
      // #1771 row 8 — read-only for both parties; the buyer reads plain words.
      return you
        ? build(
            "DISPUTED",
            "Under review",
            `${money(paid.amount, paid.currency)} · under review by your bank · ${when}`,
          )
        : build(
            "DISPUTED",
            "Disputed",
            `${money(paid.amount, paid.currency)} · disputed · ${when}`,
          );
    }
    // Refunds: the same rule the seat roster and the Payments API use (#1627).
    // REFUND_PENDING means the WHOLE charge is coming back (the booking is
    // gone, #1752); a partial one, settled or in flight, leaves it standing.
    const shown = paymentDisplayStatus({
      paymentStatus: "SUCCEEDED",
      amount: paid.amount,
      refunds: input.refunds,
    });
    const sum = (status: string) =>
      input.refunds
        .filter((r) => normalizeStatus(r.status) === status)
        .reduce((s, r) => s + Number(r.amountPaise), 0);
    const back = sum("SUCCEEDED");
    const pendingRefund = sum("PENDING");
    if (shown === "REFUNDED") {
      return build(
        "REFUNDED",
        "Refunded",
        `${money(paid.amount, paid.currency)} refunded${rail ? ` · ${rail}` : ""}`,
      );
    }
    if (pendingRefund > 0 && back + pendingRefund >= Number(paid.amount)) {
      return build(
        "REFUND_PENDING",
        "Refund pending",
        `${money(pendingRefund, paid.currency)} refund on its way${rail ? ` · ${rail}` : ""}`,
      );
    }
    if (shown === "PARTIALLY_REFUNDED" || pendingRefund > 0) {
      const parts = [`${money(paid.amount, paid.currency)} paid`];
      if (back > 0) parts.push(`${money(back, paid.currency)} refunded`);
      if (pendingRefund > 0)
        parts.push(`${money(pendingRefund, paid.currency)} refund on its way`);
      // #1770 QA — the rail rides every refund line, partial ones included.
      if (rail) parts.push(rail);
      return build("PARTIALLY_REFUNDED", "Partly refunded", parts.join(" · "));
    }
    // Locked 2026-09-13: the member did not pay a sponsored booking, so no amount.
    if (isSponsoredPayment(paid)) {
      const org = input.sponsorOrgName ?? "the organisation";
      return build("SPONSORED", "Sponsored", `Sponsored by ${org}${coPayLine}`);
    }
    if (Number(paid.amount) === 0) return build("FREE", "Free", "Free");
    return build(
      "PAID",
      "Paid",
      `${money(paid.amount, paid.currency)}${rail ? ` · ${rail}` : ""} · ${when}${coPayLine}`,
    );
  }

  const stage = moneyStage(input, booking, now);
  if (stage === "AWAITING_PAYMENT" && pending) {
    const rail = paymentRailLabel(pending);
    const until = holdExpiresAt
      ? ` · link valid until ${dayTime(holdExpiresAt, zone)}`
      : "";
    return build(
      "DUE",
      "Due",
      `${money(pending.amount, pending.currency)} due${rail ? ` · ${rail}` : ""}${until}`,
    );
  }
  // A held trial or checkout whose order is minted only on the pay page.
  if (
    stage === "AWAITING_PAYMENT" &&
    input.plan &&
    Number(input.plan.pricePaise) > 0
  ) {
    const until = holdExpiresAt
      ? ` · pay by ${dayTime(holdExpiresAt, zone)}`
      : "";
    return build(
      "DUE",
      "Due",
      `${money(input.plan.pricePaise, input.plan.currency)} due${until}`,
    );
  }
  if (stage === "PAYMENT_LAPSED") {
    const on = holdExpiresAt ? ` on ${day(holdExpiresAt, zone)}` : "";
    if (!mayHaveCharged) {
      return build(
        "NOT_DUE",
        "Not charged",
        `Nothing was charged — the payment link expired${on}.`,
      );
    }
    if (lateCaptureMayConfirm) {
      const whose = you ? "your" : `${p}'s`;
      const what = input.seatStatus ? "a place" : "the time";
      return build(
        "NOT_DUE",
        "Not completed",
        `The payment window closed${on}. If ${whose} payment still goes through, the booking is confirmed while ${what} can still be booked; otherwise the money is refunded automatically.`,
      );
    }
    const what = declined
      ? "The payment did not go through."
      : `The payment link expired${on}.`;
    return build("NOT_DUE", "Not completed", `${what} ${ifCharged}`);
  }
  if (stage === "REQUESTED") {
    // #1675 — one session-count story: the header owns "<held> of <plan>
    // sessions"; this line only prices the plan, so it no longer repeats a
    // second, differently-worded count.
    // CodeRabbit (PR #1767) — sessions <= 0 would divide by zero into an
    // Infinity unit price; a plan row is never supposed to carry that, but
    // this line no longer trusts it blindly.
    const detail =
      input.plan && Number(input.plan.pricePaise) > 0 && input.plan.sessions > 0
        ? `${money(input.plan.pricePaise, input.plan.currency)} for the plan · ${input.plan.sessions} sessions · ${money(Number(input.plan.pricePaise) / input.plan.sessions, input.plan.currency)} each`
        : undefined;
    const line = you
      ? `Not due yet — you are asked to pay after ${c} approves.`
      : `Not due yet — ${p} is asked to pay after you approve.`;
    return build("NOT_DUE", "Not due", line, detail);
  }
  if (input.plan && Number(input.plan.pricePaise) === 0)
    return build("FREE", "Free", "Free");
  if (
    input.sponsorOrgName &&
    (booking === "CONFIRMED" ||
      booking === "COMPLETED" ||
      booking === "AWAITING_DECISION" ||
      booking === "AWAITING_ALLOCATION")
  ) {
    return build(
      "SPONSORED",
      "Sponsored",
      `Sponsored by ${input.sponsorOrgName}${coPayLine}`,
    );
  }
  if (mayHaveCharged) {
    const what = declined
      ? "The payment did not go through."
      : "This order was cancelled.";
    return build("NOT_DUE", "Not completed", `${what} ${ifCharged}`);
  }
  return build(
    "NOT_DUE",
    "Not charged",
    "Nothing was charged for this booking.",
  );
}

function deriveNext(
  input: BookingPresentationInput,
  booking: BookingStateKind,
  moneyState: MoneyState,
  viewer: Viewer,
  live: OccurrenceInput[],
  holdExpiresAt: Date | null,
  now: Date,
  joinWindowMs: number,
): NextAction {
  const none: NextAction = { kind: "NONE", label: "" };
  const deadline = holdExpiresAt ?? undefined;
  const joinable = live.some((o) => {
    const start = toDate(o.startsAt).getTime();
    return (
      !o.isTentative &&
      start - joinWindowMs <= now.getTime() &&
      !isOccurrencePastGrace(o, now)
    );
  });
  const move = input.reschedule;
  if (booking === "BEING_MOVED" && move) {
    const counterparty =
      (move.by === "REQUESTER" && viewer === "CONSULTANT") ||
      (move.by === "CONSULTANT" && viewer === "CONSULTEE");
    return counterparty
      ? {
          kind: "RESPOND_TO_MOVE",
          label: "Accept new times",
          deadline: toDateOrNull(move.expiresAt) ?? undefined,
        }
      : none;
  }
  if (viewer === "CONSULTANT") {
    if (booking === "REQUESTED")
      return { kind: "APPROVE_OR_DECLINE", label: "Approve", deadline };
    // #1775 — the deadline is the pay order's own clock (the live PENDING
    // row's expiresAt), the same one the consultee's PAY carries.
    // An approved request's pay link; a pay-first checkout hold is the buyer's own.
    if (
      booking === "AWAITING_PAYMENT" &&
      normalizeStatus(input.source) !== "DIRECT_CHECKOUT"
    )
      return { kind: "REMIND_OR_WITHDRAW", label: "Remind", deadline };
    const wait = allocationWait(input, live, !!paidOf(input), now);
    if (booking === "AWAITING_ALLOCATION" && wait === "CYCLE_1")
      return {
        kind: "ALLOCATE",
        label: "Schedule cycle 1",
        deadline: allocateDeadline(input.payments) ?? undefined,
      };
    if (booking === "AWAITING_ALLOCATION" && wait === "NEXT_CYCLE")
      return {
        kind: "ALLOCATE",
        label: `Schedule the next ${input.entitlement?.nextBatch ?? 0}`,
      };
    if (booking === "CONFIRMED" && joinable)
      return { kind: "JOIN", label: "Join" };
    return none;
  }
  if (viewer === "CONSULTEE") {
    if (booking === "AWAITING_PAYMENT" && moneyState.state === "DUE") {
      const pending = input.payments.find((x) => x.paymentStatus === "PENDING");
      let amount = "";
      if (pending) amount = money(pending.amount, pending.currency);
      else if (input.plan)
        amount = money(input.plan.pricePaise, input.plan.currency);
      return {
        kind: "PAY",
        label: amount ? `Pay ${amount}` : "Pay now",
        deadline,
      };
    }
    if (booking === "PAYMENT_LAPSED" || booking === "DECLINED") {
      return { kind: "REQUEST_AGAIN", label: "Request again" };
    }
    if (booking === "CONFIRMED" && joinable)
      return { kind: "JOIN", label: "Join" };
    if (
      booking === "CONFIRMED" &&
      normalizeStatus(input.appointmentType) === "CLASS" &&
      input.series?.exitRight
    ) {
      return {
        kind: "EXIT_SERIES",
        label: `Leave the series with a full refund of the remaining ${input.series.undelivered} sessions`,
      };
    }
    if (booking === "COMPLETED")
      return { kind: "RATE", label: "Rate this session" };
  }
  return none;
}

/** A lapsed hold ends at its window, unless the learner closed it by requesting again. */
function lapsedTimelineEvent(
  input: BookingPresentationInput,
  viewer: Viewer,
  holdExpiresAt: Date | null,
): TimelineEvent {
  const again = requestedAgainEdge({
    history: input.history,
    status: input.request?.status,
  });
  if (!again) {
    return {
      at: holdExpiresAt,
      actor: "",
      label: "Payment link expired",
      done: true,
    };
  }
  const p = input.names.payer;
  return {
    at: toDateOrNull(again.createdAt),
    actor: p,
    label:
      viewer === "CONSULTEE" ? "You requested again" : `${p} requested again`,
    done: true,
  };
}

function deriveTimeline(
  input: BookingPresentationInput,
  booking: BookingStateKind,
  moneyState: MoneyState,
  viewer: Viewer,
  paidAt: Date | null,
  holdExpiresAt: Date | null,
  zone?: string | null,
): TimelineEvent[] {
  const c = input.names.consultant;
  const p = input.names.payer;
  const me = (name: string, isMe: boolean) => (isMe ? "you" : name);
  const payer = me(p, viewer === "CONSULTEE");
  const consultant = me(c, viewer === "CONSULTANT");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // The timeline names when the booking was made, not the hold clock a move restarts.
  const requestedAt = toDateOrNull(
    input.request?.bookedAt ?? input.request?.requestedAt,
  );
  const requested: TimelineEvent = {
    at: requestedAt,
    actor: p,
    label: viewer === "CONSULTEE" ? "Requested (you)" : `Requested by ${p}`,
    done: true,
  };
  // "Approved" only when the history shows the expert approving a request.
  const approval = expertApproval(input);
  const approved: TimelineEvent | null = approval
    ? {
        at: toDateOrNull(approval.createdAt),
        actor: c,
        label: `Approved (${consultant})`,
        done: true,
      }
    : booking === "REQUESTED"
      ? {
          at: null,
          actor: c,
          label: `${cap(consultant)} approve${consultant === "you" ? "" : "s"}`,
          done: false,
        }
      : null;
  const paidDone = [
    "PAID",
    "SPONSORED",
    "REFUND_PENDING",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
    "DISPUTED",
  ].includes(moneyState.state);
  const paid: TimelineEvent = {
    at: paidAt,
    actor: p,
    label: paidDone
      ? moneyState.state === "SPONSORED"
        ? `Sponsored by ${input.sponsorOrgName ?? "the organisation"}`
        : "Paid"
      : `${cap(payer)} pay${payer === "you" ? "" : "s"}${booking === "AWAITING_PAYMENT" && holdExpiresAt ? ` (link valid until ${dayTime(holdExpiresAt, zone)})` : " (link valid 24 h)"}`,
    done: paidDone,
  };
  const single = ["CONSULTATION", "TRIAL", "WEBINAR"].includes(
    normalizeStatus(input.appointmentType),
  );
  const confirmed: TimelineEvent = {
    at: null,
    actor: c,
    label: single ? "Session confirmed" : "Sessions confirmed",
    done:
      booking === "CONFIRMED" ||
      booking === "AWAITING_DECISION" ||
      booking === "COMPLETED",
  };
  const completed: TimelineEvent = {
    at: null,
    actor: booking === "AWAITING_DECISION" ? "" : c,
    label:
      booking === "AWAITING_DECISION"
        ? "Our team decides what happened"
        : "Completed",
    done: booking === "COMPLETED",
  };

  const terminal: TimelineEvent | null =
    booking === "DECLINED"
      ? { at: null, actor: c, label: `Declined (${consultant})`, done: true }
      : booking === "CANCELLED"
        ? { at: null, actor: "", label: "Cancelled", done: true }
        : booking === "PAYMENT_LAPSED"
          ? lapsedTimelineEvent(input, viewer, holdExpiresAt)
          : null;
  const refunds = refundTimeline(input);

  // A trial or a pay-first checkout is booked by the learner: no request, no approval.
  const booked: TimelineEvent = {
    ...requested,
    label: viewer === "CONSULTEE" ? "Booked (you)" : `Booked by ${p}`,
  };
  const payFirst =
    normalizeStatus(input.appointmentType) === "TRIAL" ||
    normalizeStatus(input.source) === "DIRECT_CHECKOUT";
  const requestSteps =
    paidDone && booking === "REQUESTED"
      ? [requested, paid, approved]
      : [requested, approved, paid];
  const steps = payFirst
    ? [booked, paid]
    : requestSteps.filter((e): e is TimelineEvent => e !== null);
  if (moneyState.state === "FREE") steps.splice(steps.indexOf(paid), 1);
  const events = [
    ...steps.filter((e) => e.done || !terminal),
    confirmed,
    completed,
  ];
  const kept = terminal ? events.filter((e) => e.done) : events;
  return [...kept, ...(terminal ? [terminal] : []), ...refunds];
}

// Razorpay (rfnd_) and Stripe (re_) ids; the front doors stamp a placeholder first.
const GATEWAY_REFUND_ID = /^(rfnd_|re_)/;

/** Refund progress records gateway processing, not acknowledgement from the recipient’s bank. */
const REFUND_ETA_CARD_OR_UPI =
  "bank arrival varies; receipt is not yet confirmed";
const REFUND_ETA: Partial<Record<string, string>> = {
  CREDITS: "returns as credits after processing",
  ORG: "back to the organisation",
};

function completedRefundLabel(
  partial: boolean,
  funding: string,
  amountPaise: Parameters<typeof money>[0],
  currency: Parameters<typeof money>[1],
): string {
  if (!partial)
    return funding === "ORG" || funding === "CREDITS"
      ? "Refunded"
      : "Refund processed · bank arrival not confirmed";
  // Locked 2026-09-13: a sponsored member paid nothing, so no amount.
  if (funding === "ORG") return "Refunded (partial)";
  return funding === "CREDITS"
    ? `Refunded ${money(amountPaise, currency)} (partial)`
    : `Partial refund processed · ${money(amountPaise, currency)} · bank arrival not confirmed`;
}

function refundTimeline(input: BookingPresentationInput): TimelineEvent[] {
  const paid = input.payments.find((x) => x.paymentStatus === "SUCCEEDED");
  if (!paid) return [];
  // A free booking has no money to refund, so its ₹0 refund row is no step.
  if (isFreePayment(paid)) return [];
  const funding = paymentFunding(paid);
  const eta = REFUND_ETA[funding] ?? REFUND_ETA_CARD_OR_UPI;
  return input.refunds.map((r): TimelineEvent => {
    const status = normalizeStatus(r.status);
    const at = toDateOrNull(
      status === "SUCCEEDED" || status === "FAILED"
        ? (r.updatedAt ?? r.createdAt)
        : r.createdAt,
    );
    if (status === "FAILED") {
      return {
        at,
        actor: "",
        label: "Refund failed — our team will retry or contact you",
        done: true,
        kind: "refund-failed",
      };
    }
    if (status === "SUCCEEDED") {
      const partial = Number(r.amountPaise) < Number(paid.amount);
      return {
        at,
        actor: "",
        label: completedRefundLabel(
          partial,
          funding,
          r.amountPaise,
          paid.currency,
        ),
        done: true,
        kind: "refund-completed",
      };
    }
    const atGateway = GATEWAY_REFUND_ID.test(r.refundId ?? "");
    return {
      at,
      actor: "",
      label: atGateway ? `Refund processing · ${eta}` : "Refund requested",
      done: true,
      kind: atGateway ? "refund-processing" : "refund-requested",
    };
  });
}

export function deriveBookingPresentation(
  input: BookingPresentationInput,
  viewer: Viewer,
  options: DeriveOptions,
): BookingPresentation {
  const now = options.now ?? new Date();
  const joinWindowMs = options.joinWindowMs ?? CONSULTEE_JOIN_WINDOW_MS;
  const zone = options.viewerZone;
  const live = input.occurrences.filter((o) => !isDeadOccurrence(o));
  const paidRow =
    input.payments.find((x) => x.paymentStatus === "SUCCEEDED") ?? null;
  const holdExpiresAt = toDateOrNull(input.holdExpiresAt);

  const status = bookingStatus(
    statusFacts(input, live, !!paidRow, now, options.heldOccurrenceIds),
    viewer,
    { now, zone },
  );
  const b = { state: status.stage };
  const bookingState: BookingState = {
    state: status.stage,
    label: status.label,
    tone: status.tone,
    why: status.line,
  };
  const moneyState = deriveMoney(
    input,
    b.state,
    viewer,
    holdExpiresAt,
    now,
    zone,
  );
  const nextAction = deriveNext(
    input,
    b.state,
    moneyState,
    viewer,
    live,
    holdExpiresAt,
    now,
    joinWindowMs,
  );
  const timeline = deriveTimeline(
    input,
    b.state,
    moneyState,
    viewer,
    paidRow ? toDate(paidRow.createdAt) : null,
    holdExpiresAt,
    zone,
  );
  // Money in but nothing confirmed: rows still tentative, or a single-sitting
  // kind with no live row at all (a subscription/class allocates lazily).
  const lazy = ["SUBSCRIPTION", "CLASS"].includes(
    normalizeStatus(input.appointmentType),
  );
  const settled = !(
    paidRow && (live.length > 0 ? live.every((o) => o.isTentative) : !lazy)
  );

  // #1675 — same "held" the header's bare count used (live.length), so
  // swapping one for the other never changes what number the viewer sees.
  // #1766 — the plan size is the frozen entitlement; delivered sessions are
  // named once they exist (COMPLETED and UNVERIFIED both count as held).
  const planSessions = input.plan?.sessions;
  // A parked session is UNVERIFIED, so it is held for the entitlement but not completed here.
  const completedCount = Math.max(
    0,
    live.filter(isCompletedOccurrence).length - (input.parkedSessions ?? 0),
  );
  const sessionProgress =
    (planSessions && planSessions > 1
      ? `${live.length} of ${planSessions} sessions scheduled`
      : `${live.length} sessions`) +
    (completedCount > 0 ? ` · ${completedCount} completed` : "");

  return {
    bookingState,
    moneyState,
    nextAction,
    timeline,
    sessionRowLabel: (o) =>
      rowLabel(
        o,
        b.state,
        holdExpiresAt,
        now,
        normalizeStatus(input.source) === "DIRECT_CHECKOUT",
      ),
    sessionProgress,
    settled,
  };
}

/** A history row's input: the detail page's, minus the sessions a list never carries. */
export type PaymentRowInput = Omit<BookingPresentationInput, "occurrences">;

// #1675 — list rows have no occurrences; the money half is identical to the
// detail page's, so this is the same derivation with three fields picked.
export function derivePaymentPresentation(
  input: PaymentRowInput,
  viewer: Viewer,
  options: DeriveOptions,
): Pick<BookingPresentation, "moneyState" | "nextAction" | "settled"> {
  const { moneyState, nextAction, settled } = deriveBookingPresentation(
    { ...input, occurrences: [] },
    viewer,
    options,
  );
  return { moneyState, nextAction, settled };
}
