/**
 * The public refund policy, worded from the engine's own constants so the page
 * can never promise a tier, window or allowance the quote does not apply.
 */
import { CANCEL_FREEZE_BEFORE_START_MS } from "@/lib/booking/session-window";
import { MAX_CONSULTEE_RESCHEDULES } from "@/lib/booking/reschedule-caps";
import {
  CONSULTANT_INITIATED_PCT,
  EVENT_REFUND_WINDOW_HOURS_DEFAULT,
  EVENT_REFUND_WINDOW_HOURS_MAX,
  PLATFORM_DEFAULT_TIERS,
  type RefundTier,
} from "@/lib/payments/operations/cancellation-policy";
import type { FundingRail } from "@/lib/payments/funding-rail";

const hours = (h: number) => `${h} hour${h === 1 ? "" : "s"}`;
const refund = (pct: number) =>
  pct >= 100 ? "full refund" : pct <= 0 ? "no refund" : `${pct}% refund`;

/** One line per rung of a ladder, highest notice first. */
export function tierLines(tiers: readonly RefundTier[]): string[] {
  const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
  return sorted.map((tier, i) => {
    const above = sorted[i - 1];
    if (tier.hoursBefore === 0) {
      return above
        ? `Less than ${hours(above.hoursBefore)} before the session: ${refund(tier.refundPct)}`
        : `Any time before the session: ${refund(tier.refundPct)}`;
    }
    return `${hours(tier.hoursBefore)} or more before the session: ${refund(tier.refundPct)}`;
  });
}

const freezeMinutes = CANCEL_FREEZE_BEFORE_START_MS / 60_000;

export const REFUND_POLICY_COPY = {
  consultationTiers: tierLines(PLATFORM_DEFAULT_TIERS),
  orgLadder:
    "A booking paid for by an organisation follows the cancellation ladder that organisation published. Your booking confirmation always shows the ladder that applies to you.",
  noticeRule: `Notice is counted to your next session. If you moved that session yourself, the shortest notice you gave when moving it is the notice that counts.`,
  freezeRule: `A session can't be cancelled from ${freezeMinutes} minutes before it starts until it ends, or after it has taken place. If something went wrong, report a problem from the booking.`,
  expertCancel: `If your expert, our team or the expert's organisation cancels, you get a ${CONSULTANT_INITIATED_PCT}% refund, whatever the timing.`,
  reschedules: `You can move each session up to ${MAX_CONSULTEE_RESCHEDULES} times. A proposal you withdraw, or one that ends with your original time kept, doesn't count.`,
  eventWindow: `Cancel at least ${hours(EVENT_REFUND_WINDOW_HOURS_DEFAULT)} before the event starts for a full refund. The host may set a longer window, up to ${hours(EVENT_REFUND_WINDOW_HOURS_MAX)}; the window shown when you booked is the one that applies. Inside the window your seat can't be refunded.`,
  classSeries:
    "Once a class has started, leaving refunds each session that hasn't started yet, at the notice ladder above for its own start time. A session already under way when you leave counts as attended.",
  hostCancelEvent:
    "If the host cancels the event or the whole class, every session not yet held is refunded in full.",
  subscriptionExpertCancel: `If your expert, our team or the expert's organisation cancels a subscription, every session not yet held is refunded in full, whatever the timing. Sessions already held are not refunded.`,
  subscription:
    "You can cancel a subscription at any time. Sessions not yet scheduled are refunded in full, scheduled sessions at the notice ladder above for their own start time, and sessions already held are not refunded. A session that was already refunded on its own is not refunded twice.",
} as const;

/** How long a refund takes to reach the payer, by the rail it returns on. */
export const REFUND_TIMING_BY_RAIL: Record<FundingRail, string> = {
  GATEWAY: "Back to your card or UPI in 5–7 working days.",
  CREDITS: "Your credits are restored straight away.",
  INTERNAL: "Returned to your organisation's balance straight away.",
};
