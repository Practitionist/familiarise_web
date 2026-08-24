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
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";

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
                appointment: {
                  select: {
                    webinar: {
                      select: {
                        webinarPlan: {
                          select: { consultantProfileId: true },
                        },
                      },
                    },
                    class: {
                      select: {
                        classPlan: { select: { consultantProfileId: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (
      !recording ||
      recording.listingStatus !== "PUBLISHED" ||
      !recording.listPricePaise ||
      recording.listPricePaise <= BigInt(0)
    ) {
      return NextResponse.json(
        { error: "Recording is not available for purchase", code: "NOT_LISTED" },
        { status: 404 },
      );
    }

    // Consultants don't buy their own (or other consultants') replays —
    // owners already hold playback; anyone else in the profession should be
    // a viewer, not a buyer-through-this-endpoint.
    if (session.user.consultantProfileId) {
      const apt = recording.meetingSession.slotOfAppointment.appointment;
      const ownerId =
        apt.webinar?.webinarPlan?.consultantProfileId ??
        apt.class?.classPlan?.consultantProfileId;
      if (ownerId === session.user.consultantProfileId) {
        return NextResponse.json(
          { error: "You already own this recording", code: "ALREADY_ENTITLED" },
          { status: 400 },
        );
      }
    }

    const existing = await prisma.recordingPurchase.findFirst({
      where: { recordingId, buyerId: session.user.id, status: "SUCCEEDED" },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "You already own this recording", code: "ALREADY_ENTITLED" },
        { status: 400 },
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

    await prisma.recordingPurchase.create({
      data: {
        recordingId,
        buyerId: session.user.id,
        gatewayOrderId: order.id,
        amountPaise,
        status: "PENDING",
      },
    });

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
