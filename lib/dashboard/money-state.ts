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

import { format } from "date-fns";
import type { StatusBadgeStyle } from "@/lib/labels/session-labels";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";
import { normalizeStatus } from "@/lib/appointments/status";
import { paymentDisplayStatus } from "@/lib/appointments/seat-payments";
import {
  isSponsoredPayment,
  paymentRailLabel,
  type PaymentDisplayLike,
} from "@/lib/appointments/payment-display";
import { formatCurrencyAmount } from "@/utils/formatting";

export type Viewer = "CONSULTANT" | "CONSULTEE" | "ORG_ADMIN";

/** The six tones every badge on a dashboard page draws from. */
export type Tone =
  | "neutral"
  | "info"
  | "success"
  | "caution"
  | "warning"
  | "critical";

export type BookingStateKind =
  | "REQUESTED"
  | "AWAITING_PAYMENT"
  | "PAYMENT_LAPSED"
  | "CONFIRMED"
  | "AWAITING_ALLOCATION"
  | "COMPLETED"
  | "CANCELLED"
  | "DECLINED";

export type MoneyStateKind =
  | "NOT_DUE"
  | "DUE"
  | "PAID"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "SPONSORED"
  | "DISPUTED"
  | "FREE";

export type NextActionKind =
  | "APPROVE_OR_DECLINE"
  | "PAY"
  | "REQUEST_AGAIN"
  | "JOIN"
  | "RATE"
  | "ATTEST"
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
}

export type OccurrenceInput = {
  startsAt: Date | string;
  endsAt?: Date | string | null;
  isTentative: boolean;
  completionStatus?: string | null;
  deletedAt?: Date | string | null;
};

export type PaymentInput = PaymentDisplayLike & {
  amount: bigint | number | string;
  taxAmount?: bigint | number | string | null;
  currency: string;
  createdAt: Date | string;
  expiresAt?: Date | string | null;
};

export type RefundInput = {
  amountPaise: bigint | number | string;
  status: string;
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
    requestedAt?: Date | string | null;
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
   */
  history?: { fromStatus: string; toStatus: string }[];
  /** Plan price for the not-due arithmetic line; null when the read lacks it. */
  plan?: {
    pricePaise: bigint | number | string;
    currency: string;
    sessions: number;
  } | null;
  names: { payer: string; consultant: string };
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

const PRE_APPROVAL = new Set(["PENDING", "APPROVED_PENDING_PAYMENT"]);
const CONFIRMED_FAMILY = new Set(["APPROVED", "SCHEDULED", "IN_PROGRESS"]);
const COMPLETED_FAMILY = new Set(["COMPLETED", "CONVERTED"]);
const OPEN_DISPUTES = new Set([
  "WARNING_NEEDS_RESPONSE",
  "WARNING_UNDER_REVIEW",
  "NEEDS_RESPONSE",
  "UNDER_REVIEW",
]);

const BOOKING_LABEL: Record<BookingStateKind, { label: string; tone: Tone }> = {
  REQUESTED: { label: "Requested", tone: "caution" },
  AWAITING_PAYMENT: { label: "Awaiting payment", tone: "warning" },
  PAYMENT_LAPSED: { label: "Payment lapsed", tone: "neutral" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  AWAITING_ALLOCATION: { label: "Awaiting schedule", tone: "info" },
  COMPLETED: { label: "Completed", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  DECLINED: { label: "Declined", tone: "critical" },
};

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

/** Existing palette only (lib/labels/session-labels.ts conventions). */
const TONE_CLASS: Record<Tone, { className: string; dotClassName: string }> = {
  neutral: {
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    dotClassName: "bg-zinc-400",
  },
  info: {
    className: "bg-blue-100 text-blue-900 border-blue-200",
    dotClassName: "bg-blue-500",
  },
  success: {
    className: "bg-green-100 text-green-900 border-green-200",
    dotClassName: "bg-green-500",
  },
  caution: {
    className: "bg-amber-100 text-amber-900 border-amber-200",
    dotClassName: "bg-amber-500",
  },
  warning: {
    className: "bg-orange-100 text-orange-900 border-orange-200",
    dotClassName: "bg-orange-500",
  },
  critical: {
    className: "bg-red-100 text-red-900 border-red-200",
    dotClassName: "bg-red-500",
  },
};

/** `StatusBadge` props for a tone + label. */
export function toneBadge(tone: Tone, label: string): StatusBadgeStyle {
  return { label, ...TONE_CLASS[tone] };
}

const money = (paise: bigint | number | string, currency: string) =>
  formatCurrencyAmount(Number(paise), currency);
const day = (d: Date) => format(d, "EEE d MMM");
const dayTime = (d: Date) => format(d, "EEE d MMM HH:mm");

function occurrenceEnd(o: OccurrenceInput): number {
  return (
    toDateOrNull(o.endsAt) ??
    new Date(toDate(o.startsAt).getTime() + 60 * 60 * 1000)
  ).getTime();
}

/** Held / Released / Scheduled / Completed / Cancelled — the schedule words. */
function rowLabel(
  o: OccurrenceInput,
  booking: BookingStateKind,
  holdExpiresAt: Date | null,
  now: Date,
): string {
  if (o.deletedAt || normalizeStatus(o.completionStatus) === "CANCELLED")
    return "Cancelled";
  if (normalizeStatus(o.completionStatus) === "RESCHEDULED") return "Released";
  if (o.isTentative) {
    if (booking === "AWAITING_PAYMENT") return "Held · link sent";
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
  return occurrenceEnd(o) < now.getTime() ? "Completed" : "Scheduled";
}

function deriveBooking(
  input: BookingPresentationInput,
  live: OccurrenceInput[],
  paid: boolean,
  holdExpiresAt: Date | null,
  now: Date,
): { state: BookingStateKind; label?: string; why: string } {
  const status = normalizeStatus(input.request?.status);
  const kind = normalizeStatus(input.request?.kind || input.appointmentType);
  const c = input.names.consultant;
  const p = input.names.payer;
  if (status === "REJECTED")
    return { state: "DECLINED", why: `${c} declined this request.` };
  if (status === "CANCELLED")
    return { state: "CANCELLED", why: "This booking was cancelled." };
  if (status === "EXPIRED") {
    const edges =
      input.history?.filter((h) => normalizeStatus(h.toStatus) === "EXPIRED") ??
      [];
    const lapsedLink =
      edges.length > 0
        ? edges.some(
            (h) => normalizeStatus(h.fromStatus) === "APPROVED_PENDING_PAYMENT",
          )
        : input.payments.some(
            (x) => x.paymentStatus !== "SUCCEEDED" && !!x.expiresAt,
          );
    return lapsedLink
      ? {
          state: "PAYMENT_LAPSED",
          why: "The payment link expired before it was paid.",
        }
      : {
          state: "CANCELLED",
          label: "Expired",
          why: "The request lapsed unanswered.",
        };
  }
  if (COMPLETED_FAMILY.has(status))
    return { state: "COMPLETED", why: "Every session has been held." };
  if (status === "DRAFT")
    return {
      state: "AWAITING_ALLOCATION",
      label: "Not published",
      why: "Publish it once a session is set.",
    };
  if (PRE_APPROVAL.has(status) || status === "AWAITING_PAYMENT") {
    if (paid)
      return {
        state: "REQUESTED",
        why: `Paid; ${c} is asked to approve next.`,
      };
    if (status === "PENDING")
      return { state: "REQUESTED", why: `${p} is waiting for ${c} to answer.` };
    if (holdExpiresAt && holdExpiresAt <= now) {
      return {
        state: "PAYMENT_LAPSED",
        why: "The payment link expired before it was paid.",
      };
    }
    return {
      state: "AWAITING_PAYMENT",
      why: `${c} approved; the booking confirms once it is paid.`,
    };
  }
  if (live.length === 0) {
    return {
      state: "AWAITING_ALLOCATION",
      why: `${c} has not placed the sessions on the calendar yet.`,
    };
  }
  if (CONFIRMED_FAMILY.has(status) || status === "") {
    if (live.every((o) => o.isTentative)) {
      return paid
        ? {
            state: "CONFIRMED",
            why: "Payment received; the sessions are being locked in.",
          }
        : {
            state: "AWAITING_PAYMENT",
            why: "The slots are held until the booking is paid.",
          };
    }
    if (live.every((o) => occurrenceEnd(o) < now.getTime())) {
      return { state: "COMPLETED", why: "Every session has been held." };
    }
    const noun =
      kind === "CONSULTATION" || kind === "TRIAL"
        ? "session is"
        : "sessions are";
    return { state: "CONFIRMED", why: `The ${noun} on the calendar.` };
  }
  return { state: "CONFIRMED", why: "" };
}

function deriveMoney(
  input: BookingPresentationInput,
  booking: BookingStateKind,
  viewer: Viewer,
  holdExpiresAt: Date | null,
): MoneyState {
  const c = input.names.consultant;
  const p = input.names.payer;
  const you = viewer === "CONSULTEE";
  const paid = input.payments.find((x) => x.paymentStatus === "SUCCEEDED");
  const pending = input.payments.find((x) => x.paymentStatus === "PENDING");
  const coPay = input.childPayments.filter(
    (x) => x.paymentStatus === "SUCCEEDED",
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
    const when = format(toDate(paid.createdAt), "d MMM yyyy");
    if (
      input.disputes.some((d) => OPEN_DISPUTES.has(normalizeStatus(d.status)))
    ) {
      return build(
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

  if (booking === "AWAITING_PAYMENT" && pending) {
    const rail = paymentRailLabel(pending);
    const until = holdExpiresAt
      ? ` · link valid until ${dayTime(holdExpiresAt)}`
      : "";
    return build(
      "DUE",
      "Due",
      `${money(pending.amount, pending.currency)} due${rail ? ` · ${rail}` : ""}${until}`,
    );
  }
  if (booking === "PAYMENT_LAPSED") {
    const on = holdExpiresAt ? ` on ${day(holdExpiresAt)}` : "";
    return build(
      "NOT_DUE",
      "Not charged",
      `Nothing was charged — the payment link expired${on}.`,
    );
  }
  if (booking === "REQUESTED") {
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
      booking === "AWAITING_ALLOCATION")
  ) {
    return build(
      "SPONSORED",
      "Sponsored",
      `Sponsored by ${input.sponsorOrgName}${coPayLine}`,
    );
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
      now.getTime() <= occurrenceEnd(o)
    );
  });
  if (viewer === "CONSULTANT") {
    if (booking === "REQUESTED")
      return { kind: "APPROVE_OR_DECLINE", label: "Approve", deadline };
    if (booking === "CONFIRMED" && joinable)
      return { kind: "JOIN", label: "Join" };
    return none;
  }
  if (viewer === "CONSULTEE") {
    if (booking === "AWAITING_PAYMENT" && moneyState.state === "DUE") {
      const pending = input.payments.find((x) => x.paymentStatus === "PENDING");
      const amount = pending ? money(pending.amount, pending.currency) : "";
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
    if (booking === "COMPLETED")
      return { kind: "RATE", label: "Rate this session" };
  }
  return none;
}

function deriveTimeline(
  input: BookingPresentationInput,
  booking: BookingStateKind,
  moneyState: MoneyState,
  viewer: Viewer,
  paidAt: Date | null,
  holdExpiresAt: Date | null,
): TimelineEvent[] {
  const c = input.names.consultant;
  const p = input.names.payer;
  const me = (name: string, isMe: boolean) => (isMe ? "you" : name);
  const payer = me(p, viewer === "CONSULTEE");
  const consultant = me(c, viewer === "CONSULTANT");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const requestedAt = toDateOrNull(input.request?.requestedAt);
  const requested: TimelineEvent = {
    at: requestedAt,
    actor: p,
    label: viewer === "CONSULTEE" ? "Requested (you)" : `Requested by ${p}`,
    done: true,
  };
  const approvedDone =
    !["REQUESTED", "DECLINED"].includes(booking) &&
    !(booking === "CANCELLED" && !paidAt);
  const approved: TimelineEvent = {
    at: null,
    actor: c,
    label: approvedDone
      ? `Approved (${consultant})`
      : `${cap(consultant)} approve${consultant === "you" ? "" : "s"}`,
    done: approvedDone,
  };
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
      : `${cap(payer)} pay${payer === "you" ? "" : "s"}${booking === "AWAITING_PAYMENT" && holdExpiresAt ? ` (link valid until ${dayTime(holdExpiresAt)})` : " (link valid 24 h)"}`,
    done: paidDone,
  };
  const single = ["CONSULTATION", "TRIAL", "WEBINAR"].includes(
    normalizeStatus(input.appointmentType),
  );
  const confirmed: TimelineEvent = {
    at: null,
    actor: c,
    label: single ? "Session confirmed" : "Sessions confirmed",
    done: booking === "CONFIRMED" || booking === "COMPLETED",
  };
  const completed: TimelineEvent = {
    at: null,
    actor: c,
    label: "Completed",
    done: booking === "COMPLETED",
  };

  const terminal: TimelineEvent | null =
    booking === "DECLINED"
      ? { at: null, actor: c, label: `Declined (${consultant})`, done: true }
      : booking === "CANCELLED"
        ? { at: null, actor: "", label: "Cancelled", done: true }
        : booking === "PAYMENT_LAPSED"
          ? {
              at: holdExpiresAt,
              actor: "",
              label: "Payment link expired",
              done: true,
            }
          : null;
  const refund: TimelineEvent | null =
    moneyState.state === "REFUND_PENDING"
      ? { at: null, actor: "", label: "Refund on its way", done: true }
      : moneyState.state === "REFUNDED"
        ? { at: null, actor: "", label: "Refunded", done: true }
        : null;

  // Pay-first checkout (#1586): the money landed before the answer.
  const steps =
    paidDone && booking === "REQUESTED"
      ? [requested, paid, approved]
      : [requested, approved, paid];
  if (moneyState.state === "FREE") steps.splice(steps.indexOf(paid), 1);
  const events = [
    ...steps.filter((e) => e.done || !terminal),
    confirmed,
    completed,
  ];
  const kept = terminal ? events.filter((e) => e.done) : events;
  return [
    ...kept,
    ...(terminal ? [terminal] : []),
    ...(refund ? [refund] : []),
  ];
}

export function deriveBookingPresentation(
  input: BookingPresentationInput,
  viewer: Viewer,
  options: DeriveOptions = {},
): BookingPresentation {
  const now = options.now ?? new Date();
  const joinWindowMs = options.joinWindowMs ?? 10 * 60 * 1000;
  const live = input.occurrences.filter((o) => !isDeadOccurrence(o));
  const paidRow =
    input.payments.find((x) => x.paymentStatus === "SUCCEEDED") ?? null;
  const holdExpiresAt = toDateOrNull(input.holdExpiresAt);

  const b = deriveBooking(input, live, !!paidRow, holdExpiresAt, now);
  const bookingState: BookingState = {
    state: b.state,
    label: b.label ?? BOOKING_LABEL[b.state].label,
    tone: BOOKING_LABEL[b.state].tone,
    why: b.why,
  };
  const moneyState = deriveMoney(input, b.state, viewer, holdExpiresAt);
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
  const planSessions = input.plan?.sessions;
  const sessionProgress =
    planSessions && planSessions > 1
      ? `${live.length} of ${planSessions} sessions scheduled`
      : `${live.length} sessions`;

  return {
    bookingState,
    moneyState,
    nextAction,
    timeline,
    sessionRowLabel: (o) => rowLabel(o, b.state, holdExpiresAt, now),
    sessionProgress,
    settled,
  };
}
