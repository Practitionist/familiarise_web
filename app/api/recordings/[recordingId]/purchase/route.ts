/**
 * Replay Purchase — order minting (#366)
 * POST /api/recordings/[recordingId]/purchase
 *
 * Standalone digital-good sale, deliberately outside the booking checkout:
 * no Appointment/Slot rows are created. The Razorpay order carries
 * notes.type = "recording_purchase" so the webhook dispatch settles it via
 * handleRecordingPurchaseSuccess (idempotent on gatewayOrderId).
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  cancelRazorpayOrder,
  createRazorpayOrder,
} from "@/lib/payments/core/razorpay";
import {
  isDiscoverablePlanPlan,
  loadOwnedListingRecording,
} from "@/lib/stream/recording-listing-access";
import { isDurablyOurs } from "@/lib/stream/recording-storage";
import {
  BookingLockUnavailableError,
  lockRecordingPurchase,
  RecordingPurchaseInProgressError,
} from "@/utils/appointmentlock";

type RouteParams = { params: Promise<{ recordingId: string }> };

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;

    const loaded = await loadOwnedListingRecording(recordingId, null, {
      // Buyers are consultees — no ownership requirement. Self-purchase by
      // the owning consultant is rejected separately below.
      requireOwnership: false,
    });
    if (loaded.status !== "ok") {
      return NextResponse.json(
        {
          error: "Recording is not available for purchase",
          code: "NOT_LISTED",
        },
        { status: 404 },
      );
    }

    // Sell-side eligibility (R2 review) — must match publicRecordingWhere at
    // ORDER time: published, positively priced, still AVAILABLE on Supabase,
    // under a live + discoverable plan.
    if (
      loaded.listingStatus !== "PUBLISHED" ||
      loaded.listPricePaise === null ||
      loaded.listPricePaise <= BigInt(0) ||
      !isDurablyOurs({
        status: loaded.recordingStatus,
        storageType: loaded.storageType,
      }) ||
      !isDiscoverablePlanPlan(loaded.plan.plan)
    ) {
      return NextResponse.json(
        {
          error: "This recording is no longer available for purchase.",
          code: "NOT_ELIGIBLE",
        },
        { status: 409 },
      );
    }
    // Consultants don't buy their own replays — owners already hold playback.
    if (
      session.user.consultantProfileId &&
      loaded.plan.plan.consultantProfileId === session.user.consultantProfileId
    ) {
      return NextResponse.json(
        { error: "You already own this recording", code: "ALREADY_ENTITLED" },
        { status: 400 },
      );
    }

    const buyerId = session.user.id;
    const amountPaise = loaded.listPricePaise;
    // #1584 P2-P0-02 — read → mint → create under one lock, and the PENDING
    // re-read happens INSIDE it so a second caller resumes, never re-mints.
    const outcome = await lockRecordingPurchase(
      recordingId,
      buyerId,
      async () => {
        const [owned, pendingOrder] = await Promise.all([
          prisma.recordingPurchase.findFirst({
            where: { recordingId, buyerId, status: "SUCCEEDED" },
            select: { gatewayOrderId: true },
          }),
          prisma.recordingPurchase.findFirst({
            where: { recordingId, buyerId, status: "PENDING" },
            select: { gatewayOrderId: true, amountPaise: true },
          }),
        ]);
        if (owned) return { kind: "owned" as const };
        if (pendingOrder) {
          return {
            kind: "resumed" as const,
            orderId: pendingOrder.gatewayOrderId,
            amount: Number(pendingOrder.amountPaise),
            currency: "INR",
          };
        }

        const order = await createRazorpayOrder({
          amount: Number(amountPaise),
          currency: "INR",
          paymentGateway: "RAZORPAY",
          metadata: {
            type: "recording_purchase",
            recordingId,
            userId: buyerId,
          },
        });

        try {
          await prisma.recordingPurchase.create({
            data: {
              recordingId,
              buyerId,
              gatewayOrderId: order.id,
              amountPaise,
              status: "PENDING",
            },
          });
        } catch (rowError) {
          // A payable order must not outlive its ledger row — best-effort cancel
          // at the gateway, then surface the failure.
          console.error("Failed to persist replay purchase:", rowError);
          try {
            await cancelRazorpayOrder(order.id);
          } catch (cancelError) {
            console.error("Failed to cancel stranded order:", cancelError);
          }
          throw rowError;
        }
        return {
          kind: "minted" as const,
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
        };
      },
    );

    if (outcome.kind === "owned") {
      return NextResponse.json(
        { error: "You already own this recording", code: "ALREADY_ENTITLED" },
        { status: 400 },
      );
    }
    const { kind, ...data } = outcome;
    return NextResponse.json(
      { data },
      { status: kind === "minted" ? 201 : 200 },
    );
  } catch (error) {
    // The mint lock's refusals are typed (409 busy / 503 Redis down), not faults.
    if (
      error instanceof RecordingPurchaseInProgressError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    console.error("Error creating replay purchase:", error);
    return NextResponse.json(
      { error: "Failed to start purchase" },
      { status: 500 },
    );
  }
}
