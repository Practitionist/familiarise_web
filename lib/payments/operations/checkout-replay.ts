import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import prisma from "@/lib/prisma";
import type { checkoutSchema } from "@/schemas/checkout";
import { isUnimplementedGateway } from "@/lib/payments/constants";
import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";

type CheckoutInput = z.infer<typeof checkoutSchema>;

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
    return NextResponse.json({
      success: true,
      reused: true,
      skipPayment: true,
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
