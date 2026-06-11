import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, cancelPendingLimiter } from "@/lib/rate-limit";
import { cancelPendingCheckout } from "@/lib/payments/operations/cancel-pending";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

/**
 * #849 — release the caller's own tentative checkout hold.
 *
 * DELETE expires the caller's PENDING payment, restores referral credits,
 * deletes the tentative slots, and cancels the parent request (narrow
 * from-set — never a parent another payment already confirmed). All race
 * handling lives in `cancelPendingCheckout`.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await applyRateLimit(cancelPendingLimiter, session.user.id);
  if (rl) return rl;

  const { paymentId } = await params;

  try {
    const result = await cancelPendingCheckout({
      paymentId,
      userId: session.user.id,
    });

    if (!result.ok) {
      if (result.code === "NOT_FOUND") {
        return NextResponse.json(
          { error: "Payment not found" },
          { status: 404 },
        );
      }
      // NOT_PENDING — the webhook confirmed it, the cleanup cron expired
      // it, or a parallel cancel won.
      return NextResponse.json(
        { error: "Payment is no longer pending" },
        { status: 409 },
      );
    }

    return NextResponse.json({
      success: true,
      slotsReleased: result.slotsReleased,
    });
  } catch (error) {
    // A parent that already moved on (APPROVED/SCHEDULED) rolls the whole
    // cancellation back — surface as a conflict, not a server error.
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: "Booking is no longer cancellable from checkout" },
        { status: 409 },
      );
    }
    console.error(
      JSON.stringify({
        event: "cancel_pending_failed",
        paymentId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { error: "Failed to cancel pending booking" },
      { status: 500 },
    );
  }
}
