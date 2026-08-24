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
  appointmentPlanArmsSelect,
  resolveListingPlan,
} from "@/lib/stream/recording-listing-access";

type RouteParams = { params: Promise<{ recordingId: string }> };

export async function POST(
  _request: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;

    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        id: true,
        listingStatus: true,
        listPricePaise: true,
        meetingSession: {
          select: {
            slotOfAppointment: {
              select: {
                appointment: { select: appointmentPlanArmsSelect },
              },
            },
          },
        },
      },
    });

    if (
      !recording ||
      recording.listingStatus !== "PUBLISHED" ||
      recording.listPricePaise === null ||
      !(recording.listPricePaise > BigInt(0))
    ) {
      return NextResponse.json(
        { error: "Recording is not available for purchase", code: "NOT_LISTED" },
        { status: 404 },
      );
    }

    // Consultants don't buy their own replays — owners already hold playback.
    if (session.user.consultantProfileId) {
      const listingPlan = resolveListingPlan(
        recording.meetingSession.slotOfAppointment.appointment,
      );
      if (
        listingPlan &&
        listingPlan.plan.consultantProfileId === session.user.consultantProfileId
      ) {
        return NextResponse.json(
          { error: "You already own this recording", code: "ALREADY_ENTITLED" },
          { status: 400 },
        );
      }
    }

    const [owned, pendingOrder] = await Promise.all([
      prisma.recordingPurchase.findFirst({
        where: { recordingId, buyerId: session.user.id, status: "SUCCEEDED" },
        select: { gatewayOrderId: true },
      }),
      prisma.recordingPurchase.findFirst({
        where: { recordingId, buyerId: session.user.id, status: "PENDING" },
        select: { gatewayOrderId: true, amountPaise: true },
      }),
    ]);
    if (owned) {
      return NextResponse.json(
        { error: "You already own this recording", code: "ALREADY_ENTITLED" },
        { status: 400 },
      );
    }
    // Double-click guard: resume the still-live order instead of minting a
    // second payable one for the same (buyer, recording) pair.
    if (pendingOrder) {
      return NextResponse.json(
        {
          data: {
            orderId: pendingOrder.gatewayOrderId,
            amount: Number(pendingOrder.amountPaise),
            currency: "INR",
          },
        },
        { status: 200 },
      );
    }

    const amountPaise = recording.listPricePaise;
    const order = await createRazorpayOrder({
      amount: Number(amountPaise),
      currency: "INR",
      paymentGateway: "RAZORPAY",
      metadata: {
        type: "recording_purchase",
        recordingId,
        userId: session.user.id,
      },
    });

    try {
      await prisma.recordingPurchase.create({
        data: {
          recordingId,
          buyerId: session.user.id,
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

    return NextResponse.json(
      {
        data: {
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error creating replay purchase:", error);
    return NextResponse.json(
      { error: "Failed to start purchase" },
      { status: 500 },
    );
  }
}
