/**
 * Cancellation/refund policy — snapshot-at-booking (2026-06-10 decision).
 *
 * Tiered time-based refund windows are resolved at CHECKOUT and frozen onto
 * `Appointment.cancellationPolicySnapshot`, so an org or platform editing its
 * policy later never retroactively changes a buyer's terms. The cancel flow
 * reads the snapshot; a null snapshot (pre-feature booking) falls back to the
 * platform defaults below — same maths, just not frozen.
 *
 * Org `defaultCancellationPolicy` is free TEXT today, so v1 snapshots always
 * carry the platform tiers and record the org prose for the support trail;
 * structured per-org tiers are a post-launch schema item.
 */

export interface CancellationPolicyTier {
  /** Tier applies when the booking starts at least this many hours away. */
  hoursBefore: number;
  /** Whole-number percentage of the paid amount refunded. */
  refundPct: number;
}

export interface CancellationPolicySnapshot {
  version: 1;
  source: "PLATFORM_DEFAULT" | "ORG_DEFAULT";
  tiers: CancellationPolicyTier[];
  /** Consultant-initiated cancellations always refund this percentage. */
  consultantInitiatedPct: number;
  /** Org policy prose at booking time, for the support trail. */
  orgPolicyText?: string | null;
}

// Industry-standard defaults (Calendly/Cal.com-style): full refund a day out,
// half inside the day, nothing inside two hours. Consultant-initiated is
// always 100% — the buyer did nothing wrong.
export const PLATFORM_DEFAULT_TIERS: CancellationPolicyTier[] = [
  { hoursBefore: 24, refundPct: 100 },
  { hoursBefore: 2, refundPct: 50 },
  { hoursBefore: 0, refundPct: 0 },
];

export function resolveCancellationPolicySnapshot(params?: {
  orgPolicyText?: string | null;
}): CancellationPolicySnapshot {
  return {
    version: 1,
    source: "PLATFORM_DEFAULT",
    tiers: PLATFORM_DEFAULT_TIERS,
    consultantInitiatedPct: 100,
    orgPolicyText: params?.orgPolicyText ?? null,
  };
}

/**
 * Percentage of the paid amount to refund for a cancellation `hoursUntilStart`
 * hours before the booking starts. Negative hours (already started/past)
 * refund nothing unless consultant-initiated.
 */
export function computeRefundPct(
  snapshot: CancellationPolicySnapshot | null | undefined,
  hoursUntilStart: number,
  isConsultantInitiated: boolean,
): number {
  const policy = snapshot ?? resolveCancellationPolicySnapshot();
  if (isConsultantInitiated) return policy.consultantInitiatedPct;
  if (hoursUntilStart < 0) return 0;
  // Tiers sorted descending by hoursBefore; first tier whose threshold the
  // cancellation clears wins.
  const sorted = [...policy.tiers].sort(
    (a, b) => b.hoursBefore - a.hoursBefore,
  );
  for (const tier of sorted) {
    if (hoursUntilStart >= tier.hoursBefore) return tier.refundPct;
  }
  return 0;
}

/** Parse the Json column back into the typed snapshot (defensive). */
export function parsePolicySnapshot(
  raw: unknown,
): CancellationPolicySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<CancellationPolicySnapshot>;
  if (s.version !== 1 || !Array.isArray(s.tiers)) return null;
  return s as CancellationPolicySnapshot;
}

/** Everything the quote needs, all of it read off `BookingRefundContext`. */
export interface BookingRefundQuoteInput {
  /** The raw `Appointment.cancellationPolicySnapshot` column; parsed here. */
  policySnapshot: unknown;
  /** Null when the booking has no undelivered session left. */
  hoursUntilNextSession: number | null;
  /** Slots of any status on the booking; zero means none was ever scheduled. */
  slotsTotal: number;
  /** Sessions still owed to the buyer — the proration numerator. */
  sessionsRemaining: number;
  /** Only a subscription prorates; every other booking refunds off the whole price. */
  isSubscription: boolean;
  isConsultantInitiated: boolean;
  /** Gross captured on the booking's payment, in paise. */
  grossPaise: number;
  /** Gross less anything already given back. */
  refundablePaise: number;
}

export interface BookingRefundQuote {
  refundPct: number;
  /** The notice the tier table was asked about; infinite when never scheduled. */
  noticeHours: number;
  /** The undelivered share of the price, before the tier percentage. */
  proratedBasePaise: number;
  /** True only when proration actually moved the number. */
  prorated: boolean;
  /** What the cancellation pays back, clamped to the refundable balance. */
  refundPaise: number;
}

/**
 * What cancelling a 1:1 booking right now pays back (#1319).
 *
 * The cancel route and its preview both used to compute this inline, the same
 * four steps in the same order, in two files — which is the shape of a number
 * that eventually stops agreeing with itself. The preview's whole purpose is to
 * tell a buyer what the click will do, so a quote that restates the rule rather
 * than calling it is a second opinion. Both sides call this now.
 *
 * The steps, and why each is what it is:
 *
 *   - Notice. A booking with no slot ever scheduled has INFINITE notice, not
 *     negative notice. Mapping "never allocated" onto the same -1 as "already
 *     started" made cancelling earlier score worse than cancelling later, which
 *     no tier table can mean. It is keyed on `slotsTotal` deliberately, because
 *     deriving it from the absence of live and completed slots would also match
 *     a booking whose slots have all been cancelled.
 *   - Tier. `computeRefundPct` against the terms frozen at purchase.
 *   - Proration (#1006). The refundable base is the undelivered share of the
 *     plan price. The denominator is every session the plan ever held time for,
 *     which is `slotsTotal` — not completed plus live, because summing only
 *     those drops every terminal-but-not-completed session out of the plan and
 *     the quote then promises more than the cancel pays (#1174). A plan with
 *     `slotsTotal === 0` keeps the full gross: that is the never-scheduled
 *     booking the notice step already tiers at 100%.
 *   - Clamp. To the remaining refundable balance, not the gross. Against a
 *     payment carrying an earlier partial refund the gross overshoots, the
 *     refund operation rejects the whole request with AMOUNT_EXCEEDS_REFUNDABLE,
 *     and the buyer loses the remainder they were owed.
 */
export function quoteBookingRefund(
  input: BookingRefundQuoteInput,
): BookingRefundQuote {
  const neverScheduled = input.slotsTotal === 0;
  const noticeHours = neverScheduled
    ? Number.POSITIVE_INFINITY
    : (input.hoursUntilNextSession ?? -1);

  const refundPct = computeRefundPct(
    parsePolicySnapshot(input.policySnapshot),
    noticeHours,
    input.isConsultantInitiated,
  );

  const isProratable = input.isSubscription && input.slotsTotal > 0;
  const proratedBasePaise = isProratable
    ? Math.floor(
        (input.grossPaise * input.sessionsRemaining) / input.slotsTotal,
      )
    : input.grossPaise;

  return {
    refundPct,
    noticeHours,
    proratedBasePaise,
    prorated: isProratable && input.sessionsRemaining < input.slotsTotal,
    refundPaise: Math.min(
      Math.floor((proratedBasePaise * refundPct) / 100),
      input.refundablePaise,
    ),
  };
}
