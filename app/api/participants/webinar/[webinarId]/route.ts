import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const webinarEvent = await prisma.webinar.findUnique({
      where: {
        id: webinarId,
      },
      include: {
        webinarPlan: true,
        appointment: {
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

    if (!webinarEvent) {
      return new NextResponse("Webinar not found", { status: 404 });
    }

    // Get unique participants by user ID
    const participants = Array.from(
      new Map(
        webinarEvent.appointment?.slotsOfAppointment
          ?.flatMap((slot) => slot.user || [])
          .map((user) => [user.id, user]) || [],
      ).values(),
    );

    return NextResponse.json({
      webinarEvent,
      participants,
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error("[WEBINAR_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Remove user from all slots in the appointment
    const webinarEvent = await prisma.webinar.findUnique({
      where: { id: webinarId },
      include: {
        appointment: {
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

    if (!webinarEvent) {
      return new NextResponse("Webinar not found", { status: 404 });
    }

    // Disconnect user from all slots they are in
    if (webinarEvent.appointment) {
      for (const slot of webinarEvent.appointment.slotsOfAppointment) {
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
    Sentry.captureException(error);
    console.error("[WEBINAR_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
