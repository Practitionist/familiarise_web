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
  const sorted = [...policy.tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
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
