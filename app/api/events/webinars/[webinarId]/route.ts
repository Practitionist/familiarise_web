import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
  authorizeEventAccess,
} from "@/lib/auth-helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { webinarId } = await params;

    const authz = await authorizeEventAccess(session, "webinar", webinarId);
    if (authz) return authz;

    const webinarData = await prisma.webinar.findUniqueOrThrow({
      where: { id: webinarId },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: {
              include: {
                user: true,
              },
            },
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
        waitlist: true,
      },
    });

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }
    console.error("Error fetching webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the webinar" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { webinarId } = await params;
    const body = await request.json();

    // Only the owning consultant or ADMIN/STAFF can update a webinar instance
    const webinarData = await prisma.webinar.update({
      where: {
        id: webinarId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              webinarPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      data: {
        status: body.status,
        feedbackSummary: body.feedbackSummary,
        webinarPlan:
          isPrivileged(session.user.role) && body.webinarPlanId
            ? { connect: { id: body.webinarPlanId } }
            : undefined,
        appointment:
          isPrivileged(session.user.role) && body.appointmentId
            ? { connect: { id: body.appointmentId } }
            : undefined,
      },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: {
              include: {
                user: true,
              },
            },
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
        waitlist: true,
      },
    });

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }
    console.error("Error updating webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the webinar" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { webinarId } = await params;

    // FIX #425: Check for active bookings/payments before allowing deletion
    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      select: {
        appointment: {
          select: {
            payment: { where: { paymentStatus: "SUCCEEDED" }, select: { id: true } },
            slotsOfAppointment: { where: { startsAt: { gt: new Date() } }, select: { id: true } },
          },
        },
      },
    });
    if (webinar?.appointment?.payment?.length) {
      return NextResponse.json(
        { error: "Cannot delete webinar with active payments. Cancel or refund first." },
        { status: 400 },
      );
    }
    if (webinar?.appointment?.slotsOfAppointment?.length) {
      return NextResponse.json(
        { error: "Cannot delete webinar with upcoming scheduled slots." },
        { status: 400 },
      );
    }

    // Only the owning consultant or ADMIN/STAFF can delete a webinar instance
    const webinarData = await prisma.webinar.delete({
      where: {
        id: webinarId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              webinarPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: {
              include: {
                user: true,
              },
            },
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
        waitlist: true,
      },
    });

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }
    console.error("Error deleting webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the webinar" },
      { status: 500 },
    );
  }
}
