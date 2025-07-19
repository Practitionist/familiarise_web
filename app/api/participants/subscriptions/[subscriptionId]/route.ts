import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const subscription = await prisma.subscription.findUnique({
      where: {
        id: subscriptionId,
      },
      include: {
        subscriptionPlan: true,
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!subscription) {
      return new NextResponse("Subscription not found", { status: 404 });
    }

    // For subscriptions, participants include the consultant and consultee
    const participants = [];
    
    // Add the consultee who requested the subscription
    if (subscription.requestedBy.user) {
      participants.push(subscription.requestedBy.user);
    }

    // Add any users from appointment slots (typically the consultant)
    const slotUsers = subscription.appointments
      ?.flatMap(
        (appointment) =>
          appointment.slotsOfAppointment?.flatMap(
            (slot) => slot.user || [],
          ) || [],
      ) || [];

    // Get unique participants by user ID (avoid duplicates)
    const uniqueUsers = Array.from(
      new Map(
        [...participants, ...slotUsers].map((user) => [user.id, user])
      ).values()
    );

    return NextResponse.json({
      subscription,
      participants: uniqueUsers,
    });
  } catch (error) {
    console.error("[SUBSCRIPTION_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Find the subscription
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    if (!subscription) {
      return new NextResponse("Subscription not found", { status: 404 });
    }

    // Remove user from all slots in all appointments for this subscription
    for (const appointment of subscription.appointments) {
      for (const slot of appointment.slotsOfAppointment) {
        if (slot.user.some((user) => user.id === userId)) {
          await prisma.slotOfAppointment.update({
            where: { id: slot.id },
            data: {
              user: {
                disconnect: { id: userId },
              },
            },
          });
        }
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[SUBSCRIPTION_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
