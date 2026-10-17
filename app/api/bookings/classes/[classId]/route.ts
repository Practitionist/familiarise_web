import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  authorizeEventAccess,
} from "@/lib/auth-helpers";
import { ClassInstanceUpdateSchema } from "@/schemas/event-instance";
import { PROFILE_WITH_USER_SELECT } from "@/lib/booking/list-selects";
import {
  deleteUntouchedOffering,
  offeringDeleteRefusal,
  OfferingInUseError,
  UNTOUCHED_EVENT,
} from "@/lib/booking/offering-delete";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classId } = await params;

    const authz = await authorizeEventAccess(
      session,
      "class",
      classId,
      request.method,
    );
    if (authz) return authz;

    const classData = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: {
        classPlan: {
          include: {
            consultantProfile: PROFILE_WITH_USER_SELECT,
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointment: {
          include: {
            occurrences: {
              include: {
                // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classId } = await params;
    const parsed = ClassInstanceUpdateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid class update", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    // Cancellation owns refunds and history, so status never changes here.
    if (parsed.data.status !== undefined) {
      return NextResponse.json(
        {
          error: "Cancel a class through its cancel action, not an update.",
          code: "USE_CANCEL_ROUTE",
        },
        { status: 409 },
      );
    }

    // Only the owning consultant or ADMIN/STAFF can update a class instance
    const classData = await prisma.class.update({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      data: {
        schedulingPeriodStartsAt: parsed.data.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: parsed.data.schedulingPeriodEndsAt,
        feedbackSummary: parsed.data.feedbackSummary,
      },
      include: {
        classPlan: {
          include: {
            consultantProfile: PROFILE_WITH_USER_SELECT,
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointment: {
          include: {
            occurrences: {
              include: {
                // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classId } = await params;

    // Only the owning consultant or ADMIN/STAFF may delete an instance. The
    // same filter scopes the read and the delete, so a foreign id is a 404
    // rather than an existence oracle.
    const owned = {
      id: classId,
      ...(isPrivileged(session.user.role)
        ? {}
        : {
            classPlan: {
              consultantProfileId:
                session.user.consultantProfileId ?? "__none__",
            },
          }),
    };

    // Ownership first, so a stranger cannot hold the buyers' checkout lock
    // for this event by calling DELETE in a loop.
    const mine = await prisma.class.findFirst({
      where: owned,
      select: { id: true },
    });
    if (!mine) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }

    // #1846 CT-02 — Delete only while nobody has booked or paid (#1527
    // decision 6). The guard counts payments of EVERY status, since a
    // PENDING or FAILED Payment cascades with the appointment as surely as a
    // captured one, and it rides the DELETE's WHERE in one Serializable
    // transaction under the event's checkout lock
    // (lib/booking/offering-delete.ts). An unsold upcoming instance is
    // deletable now; anything ever booked is archived instead.
    const classData = await deleteUntouchedOffering(
      "CLASS",
      classId,
      async (tx) => {
        const row = await tx.class.findFirst({
          where: owned,
          include: {
            classPlan: {
              include: {
                consultantProfile: PROFILE_WITH_USER_SELECT,
                topics: true,
                classContents: { orderBy: { order: "asc" } },
              },
            },
            appointment: { include: { occurrences: true } },
          },
        });
        if (!row) return null;
        const { count } = await tx.class.deleteMany({
          where: { ...owned, ...UNTOUCHED_EVENT },
        });
        if (count === 0) throw new OfferingInUseError("CLASS");
        return row;
      },
    );
    if (!classData) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    const refusal = offeringDeleteRefusal(error);
    if (refusal) {
      return NextResponse.json(refusal.body, { status: refusal.status });
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error deleting class:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the class" },
      { status: 500 },
    );
  }
}
