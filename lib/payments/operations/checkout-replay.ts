import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import prisma from "@/lib/prisma";
import type { checkoutSchema } from "@/schemas/checkout";
import { isUnimplementedGateway } from "@/lib/payments/constants";
import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";
import { liveParticipant } from "@/lib/booking/participants";
import { ErrorTypes } from "@/lib/errors/classification/payment-error-classification";
import {
  AUTO_REFUNDED_PREFIX,
  AUTO_REFUND_PENDING_PREFIX,
  AUTO_REFUND_STUCK_PREFIX,
  MANUAL_RECOVERY_PREFIX,
  REFUND_STATUSES_RETURNING_MONEY,
} from "@/lib/payments/webhooks/auto-refund-marker";

type CheckoutInput = z.infer<typeof checkoutSchema>;

/** What became of a paid checkout, read from its own rows. */
export type PaidReplayOutcome =
  "booked" | "refunded" | "being_refunded" | "needs_support";

/**
 * The outcome of a SUCCEEDED payment. A capture-race marker speaks first (it
 * means the money funded no booking), then a full refund, then the buyer's
 * live seat; a refund on its way or already paid explains a booking that ended.
 */
function paidReplayOutcome(row: {
  amount: number;
  description: string | null;
  refundOwedKey: string | null;
  refunds: { status: string; amountPaise: number }[];
  appointment: { deletedAt: Date | null; participants: unknown[] } | null;
}): PaidReplayOutcome {
  const marker = row.description ?? "";
  if (marker.startsWith(AUTO_REFUND_PENDING_PREFIX)) return "being_refunded";
  if (marker.startsWith(AUTO_REFUNDED_PREFIX)) return "refunded";
  if (
    marker.startsWith(AUTO_REFUND_STUCK_PREFIX) ||
    marker.startsWith(MANUAL_RECOVERY_PREFIX)
  ) {
    return "needs_support";
  }
  const refundedPaise = row.refunds
    .filter((r) => r.status === "SUCCEEDED")
    .reduce((sum, r) => sum + r.amountPaise, 0);
  if (row.amount > 0 && refundedPaise >= row.amount) return "refunded";
  const live =
    row.appointment !== null &&
    row.appointment.deletedAt === null &&
    row.appointment.participants.length > 0;
  if (live) return "booked";
  if (
    row.refundOwedKey !== null ||
    row.refunds.some((r) => r.status === "PENDING")
  ) {
    return "being_refunded";
  }
  return refundedPaise > 0 ? "refunded" : "needs_support";
}

/** The refusal a replay answers for a paid checkout that has no live booking. */
const UNBOOKED_REPLAY: Record<
  Exclude<PaidReplayOutcome, "booked">,
  { errorType: string; error: string }
> = {
  refunded: {
    errorType: ErrorTypes.CHECKOUT_REFUNDED,
    error:
      "This payment was refunded, so nothing is booked. Refresh the page to book again.",
  },
  being_refunded: {
    errorType: ErrorTypes.CHECKOUT_REFUND_IN_PROGRESS,
    error:
      "A refund for this payment is on its way, so this checkout is closed. You do not need to pay again; refresh the page to start a new booking.",
  },
  needs_support: {
    errorType: ErrorTypes.CHECKOUT_NEEDS_SUPPORT,
    error:
      "You were charged for this checkout but it has no active booking. Please contact support and do not pay again; we will put it right.",
  },
};

// #828 — replay the original checkout response for a duplicate attempt. The
// stored Payment carries enough for the client to reopen the gateway with the
// SAME order instead of minting (and possibly paying) a second one. Scoped to
// the caller's userId so a guessed key can't read someone else's payment.
// Exported for the #828 regression tests; the checkout route is the prod caller.
export async function replayByIdempotencyKey(
  userId: string,
  key: string,
  fingerprint: string,
): Promise<NextResponse | "fingerprint-mismatch" | null> {
  const existing = await prisma.payment.findFirst({
    where: { clientIdempotencyKey: key, userId },
    select: {
      id: true,
      requestFingerprint: true,
      paymentIntent: true,
      paymentStatus: true,
      paymentGateway: true,
      amount: true,
      currency: true,
      appointmentId: true,
      isMockPayment: true,
      expiresAt: true,
      description: true,
      refundOwedKey: true,
      refunds: {
        where: { status: { in: REFUND_STATUSES_RETURNING_MONEY } },
        select: { status: true, amountPaise: true },
      },
      appointment: {
        select: {
          deletedAt: true,
          // The caller's own seat or party row, while it is live.
          participants: {
            where: liveParticipant(userId),
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!existing) return null;
  // Same key, different priced inputs: the caller mints a fresh attempt.
  if (
    existing.requestFingerprint &&
    existing.requestFingerprint !== fingerprint
  ) {
    return "fingerprint-mismatch";
  }
  if (existing.paymentStatus === "SUCCEEDED") {
    const outcome = paidReplayOutcome({
      ...existing,
      amount: Number(existing.amount),
    });
    if (outcome !== "booked") {
      return NextResponse.json(
        {
          ...UNBOOKED_REPLAY[outcome],
          outcome,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      success: true,
      reused: true,
      skipPayment: true,
      outcome,
      appointmentId: existing.appointmentId ?? undefined,
      message: "This checkout was already completed.",
    });
  }
  // The first attempt's seat is committed and its order still being minted.
  if (
    existing.paymentStatus === "PENDING" &&
    isPreMintIntent(existing.paymentIntent)
  ) {
    return NextResponse.json(
      {
        error: "Your checkout is still being prepared. Try again in a moment.",
        errorType: "CHECKOUT_IN_PROGRESS",
        retryAfter: 2,
      },
      { status: 409, headers: { "Retry-After": "2" } },
    );
  }
  // Only an implemented gateway minted a resumable order; any other PENDING row gets the 409.
  if (
    existing.paymentStatus === "PENDING" &&
    !isUnimplementedGateway(existing.paymentGateway)
  ) {
    return NextResponse.json({
      success: true,
      reused: true,
      orderId: existing.paymentIntent,
      // The row the buyer's "Cancel checkout" releases.
      paymentId: existing.id,
      paymentIntent: { id: existing.paymentIntent, client_secret: null },
      amount: Number(existing.amount),
      currency: existing.currency,
      isMockPayment: existing.isMockPayment,
      // #1861 L1 — Checkout's `timeout` is sized to the hold's end.
      holdExpiresAt: existing.expiresAt?.toISOString() ?? null,
      message: "Resuming your in-progress checkout.",
    });
  }
  // Terminal (FAILED/CANCELED/...) — this logical attempt is dead; the client
  // must mint a fresh key for a new attempt (the wallet top-up contract).
  return NextResponse.json(
    {
      error:
        "A previous attempt for this checkout already failed. Refresh and try again.",
      errorType: "IDEMPOTENT_REPLAY_TERMINAL",
      timestamp: new Date().toISOString(),
    },
    { status: 409 },
  );
}

/**
 * The priced inputs behind one checkout attempt. A replay under the same key
 * with a different fingerprint (a coupon, credits, org or window changed) is a
 * new attempt, never the old order at the old price.
 */
export function checkoutRequestFingerprint(input: CheckoutInput): string {
  const priced = [
    input.appointmentType,
    input.planId,
    input.eventId ?? "",
    instantKey(input.startsAt),
    instantKey(input.endsAt),
    instantKey(input.schedulingPeriodStartsAt),
    input.discountCode?.trim().toUpperCase() ?? "",
    input.useReferralCredits === true ? "credits" : "",
    input.organizationId ?? "",
    input.renewsSubscriptionId ?? "",
  ];
  return createHash("sha256").update(JSON.stringify(priced)).digest("hex");
}

/** One spelling per instant, so `…:00Z` and `…:00.000Z` fingerprint alike. */
function instantKey(value: string | null | undefined): string {
  if (!value) return "";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}
