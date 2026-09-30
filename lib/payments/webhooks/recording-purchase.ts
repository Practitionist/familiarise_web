/**
 * Replay purchase webhook settlement (#366).
 *
 * notes.type === "recording_purchase" orders are NOT Payment rows, so the
 * legacy handlePaymentSuccess family would silently no-op on them. This
 * handler flips the matching RecordingPurchase row PENDING → SUCCEEDED.
 *
 * Idempotency: keyed on gatewayOrderId (unique). A replayed capture hits the
 * already-SUCCEEDED early return. `payment.failed` marks the row FAILED only
 * from PENDING — a capture that raced ahead of the failure event wins.
 *
 * Two money rules live here, and both are about the same thing: a row that says
 * SUCCEEDED is a promise of permanent replay access, so nothing may write it
 * without checking what was actually captured.
 */
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";

export async function handleRecordingPurchaseSuccess(
  orderId: string,
  gatewayPaymentId?: string,
  /**
   * Captured amount in paise, ONLY when it provably came off a gateway PAYMENT
   * entity. Deliberately optional: on `order.paid` Razorpay may ship the order
   * total instead of the settled figure, and treating the order total as proof
   * of settlement is how a partial payment gets marked paid — the exact trap
   * `routeCapturedPayment` already documents for the org path, which withholds
   * the amount on the same reasoning. `undefined` means "we cannot check", and
   * the settle proceeds.
   */
  capturedAmountPaise?: number,
): Promise<void> {
  const purchase = await prisma.recordingPurchase.findUnique({
    where: { gatewayOrderId: orderId },
    select: { id: true, status: true, amountPaise: true },
  });

  if (!purchase) {
    // Unknown order — log loudly; the sweeper can't re-drive what has no row.
    console.error(
      `[recording-purchase] captured order ${orderId} has no RecordingPurchase row`,
    );
    Sentry.captureMessage(
      `[recording-purchase] captured order without row: ${orderId}`,
      { level: "error", tags: { subsystem: "payments" } },
    );
    return;
  }

  if (purchase.status === "SUCCEEDED") return; // idempotent replay

  // D6 — amount parity. This handler used to ignore the captured amount
  // entirely and flip the row on nothing but the order id, so a partial or
  // tampered capture produced a permanent entitlement for a replay the buyer
  // never paid full price for — and unlike an appointment, nothing downstream
  // ever reconciled it: there is no Payment row, no earnings leg, no invoice.
  // A paid replay is also the one sale where the buyer receives a durable
  // artefact (the recording), so an underpayment is unrecoverable later.
  //
  // The comparison is in paise on both sides, as #780 requires: the COLUMN is
  // BigInt and `lib/prisma-extensions.ts` converts every BigInt column to a
  // `number` on read, so `purchase.amountPaise` is already a number here and
  // wrapping it in `BigInt()` would be the wrong instinct. The gateway figure is
  // a paise integer too. `isSafeInteger` on both is the guard that matters —
  // above 2^53 a float comparison would silently accept a mismatch, and that is
  // a ₹90-lakh-crore distance, so the assert is a formality that documents the
  // boundary rather than a check anyone expects to fire.
  if (capturedAmountPaise !== undefined) {
    const expected = purchase.amountPaise;
    const captured = Math.trunc(capturedAmountPaise);
    if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(captured)) {
      console.error(
        `[recording-purchase] refusing to settle ${orderId}: amount outside the exact-integer range`,
      );
      Sentry.captureMessage(
        `[recording-purchase] refusing to settle: amount outside the exact-integer range`,
        {
          level: "error",
          tags: { subsystem: "payments" },
          extra: { orderId, expectedPaise: expected, capturedPaise: captured },
        },
      );
      return;
    }
    if (captured !== expected) {
      console.error(
        `[recording-purchase] capture amount mismatch for ${orderId}: expected ${expected}, got ${captured}`,
      );
      Sentry.captureMessage(
        `[recording-purchase] refusing to settle: capture amount does not match the order`,
        {
          level: "error",
          tags: { subsystem: "payments" },
          extra: { orderId, expectedPaise: expected, capturedPaise: captured },
        },
      );
      return;
    }
  }

  // Conditional, not a bare update: the row must still be PENDING. Two
  // concurrent deliveries of the same capture (webhook + sweeper re-drive) both
  // reach this point, and only the first should stamp the gateway payment id.
  const settled = await prisma.recordingPurchase.updateMany({
    where: { id: purchase.id, status: "PENDING" },
    data: {
      status: "SUCCEEDED",
      ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
    },
  });
  if (settled.count === 0) return;
}

export async function handleRecordingPurchaseFailure(
  orderId: string,
): Promise<void> {
  // Only PENDING → FAILED; a captured (SUCCEEDED) purchase can never be
  // flipped to FAILED by an out-of-order failure event.
  await prisma.recordingPurchase.updateMany({
    where: { gatewayOrderId: orderId, status: "PENDING" },
    data: { status: "FAILED" },
  });
}

/**
 * D6 — revoke a replay entitlement on refund.
 *
 * `RecordingPurchaseStatus.REFUNDED` existed in the schema from #366 with zero
 * writers anywhere in the repo, so nothing could ever reach it. That is not a
 * cosmetic gap: the entitlement check in
 * `app/api/stream/recordings/[recordingId]` reads `status: "SUCCEEDED"` and
 * nothing else, so a buyer who had a replay refunded kept permanent VOD access
 * to it forever. The alternative offered — deleting the enum value — needs a
 * schema migration, and the schema belongs to another bucket; worse, it would
 * have papered over the access bug rather than fixing it.
 *
 * Revokes only on a FULL-value refund, and only once the gateway says the money
 * actually moved (`status: "processed"`). A partial refund leaves the
 * entitlement alone: proportional refunds on a digital good are a support
 * decision nobody has implemented, and silently revoking access someone partly
 * paid for is worse than the reverse. The gap this leaves — N partial refunds
 * that add up to the full price still not revoking — needs a cumulative
 * `refundedPaise` column on `RecordingPurchase`, which is a schema change and is
 * therefore reported rather than made here.
 *
 * Returns whether this refund belonged to a replay purchase at all, so the
 * dispatcher can stop routing it into the B2C/organisation refund cascade. That
 * matters: a replay order has no `Payment`, no `WalletTopUp` and no
 * `OrganizationInvoice`, so `handleRefundCreated` finds nothing and returns a
 * `DeferSignal` on Razorpay — which parks the event unprocessed for the sweeper
 * to re-drive until it hits the 168-hour give-up cap, for a refund that was in
 * fact fully handled right here.
 */
export async function handleRecordingPurchaseRefund(params: {
  orderId: string;
  /** Gateway refund status — only `processed` means the money has moved. */
  status: string;
  /** Refunded amount in paise, for the full-value test. */
  amountPaise: number;
}): Promise<boolean> {
  const purchase = await prisma.recordingPurchase.findUnique({
    where: { gatewayOrderId: params.orderId },
    select: { id: true, status: true, amountPaise: true },
  });
  if (!purchase) return false;

  if (params.status !== "processed") {
    // Pending or failed: nothing to revoke. Returning true still short-circuits
    // the B2C cascade, because this order is known to be a replay purchase and
    // the cascade would only defer forever.
    return true;
  }

  if (Math.trunc(params.amountPaise) < purchase.amountPaise) {
    console.warn(
      `[recording-purchase] partial refund on ${params.orderId}: ${params.amountPaise} < ${purchase.amountPaise} — entitlement left in place`,
    );
    return true;
  }

  // #1829 — the CAS has to cover BOTH live states, not just the settled one.
  //
  // Razorpay can deliver `refund.processed` BEFORE `payment.captured`. The row is
  // then still PENDING, the old `status: "SUCCEEDED"` filter matched zero rows,
  // and this function returned `true` all the same — which the dispatcher reads
  // as "handled, do not cascade". The event was marked processed, the later
  // capture settled the row to SUCCEEDED, and the buyer kept permanent replay
  // access after a full refund. Nothing errored; the row simply read SUCCEEDED.
  //
  // Flipping PENDING → REFUNDED as well is the fix, and it is free: the settle
  // path is itself CAS'd on `status: "PENDING"`, so a row already marked REFUNDED
  // cannot be settled afterwards. The two orderings converge on the same state
  // instead of one of them winning by arrival time.
  const revoked = await prisma.recordingPurchase.updateMany({
    where: { id: purchase.id, status: { in: ["SUCCEEDED", "PENDING"] } },
    data: { status: "REFUNDED" },
  });
  if (revoked.count > 0) {
    console.warn(
      `[recording-purchase] refund revoked replay entitlement for order ${params.orderId} (was ${purchase.status})`,
    );
  } else {
    // Already terminal — a duplicate delivery, or a refund racing a previous
    // one. Not an error, and worth a line because "refunded twice" and "refund
    // matched nothing" are different facts.
    console.warn(
      `[recording-purchase] refund for ${params.orderId} matched no live row (status ${purchase.status})`,
    );
  }
  return true;
}
