import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma, ClassStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  authorizeEventAccess,
} from "@/lib/auth-helpers";
import { CLASS_EVENT_ALLOWED_FROM } from "@/lib/booking/transitions";
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

    const authz = await authorizeEventAccess(session, "class", classId);
    if (authz) return authz;

    const classData = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
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

  // Set once a guarded status write is attempted; lets the P2025 handler
  // below distinguish a CAS-guard miss (409) from a missing row (404).
  let statusWriteAttempted = false;

  try {
    const { classId } = await params;
    const body = await request.json();

    // Doctrine #1 — status writes go through the CAS map. `body.status` used
    // to be written raw, so an owner could drive illegal edges that
    // CLASS_EVENT_ALLOWED_FROM exists to prevent. The allowed-from set rides
    // the UPDATE's WHERE below, so a racing transition matches zero rows.
    const requestedStatus =
      typeof body.status === "string"
        ? (body.status as ClassStatus)
        : undefined;
    if (
      requestedStatus &&
      !Object.values(ClassStatus).includes(requestedStatus)
    ) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    let allowedFrom: ClassStatus[] | null = null;
    if (requestedStatus) {
      const current = await prisma.class.findUnique({
        where: { id: classId },
        select: { status: true },
      });
      if (!current) {
        return NextResponse.json({ error: "Class not found" }, { status: 404 });
      }
      allowedFrom = CLASS_EVENT_ALLOWED_FROM[requestedStatus];
      if (!allowedFrom.includes(current.status)) {
        return NextResponse.json(
          {
            error: `Illegal transition: ${current.status} → ${requestedStatus}`,
            code: "ILLEGAL_TRANSITION",
          },
          { status: 409 },
        );
      }
    }
    statusWriteAttempted = Boolean(requestedStatus);

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
        ...(requestedStatus && allowedFrom
          ? { status: { in: allowedFrom } }
          : {}),
      },
      data: {
        schedulingPeriodStartsAt: body.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: body.schedulingPeriodEndsAt,
        status: requestedStatus,
        recordingUrls: body.recordingUrls,
        feedbackSummary: body.feedbackSummary,
      },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
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
      // A WHERE miss can be either "no such class" or "the status moved
      // between our read and this write" — the latter is the CAS guard
      // working and must surface as 409, not a phantom 404.
      return NextResponse.json(
        {
          error: statusWriteAttempted
            ? "Class not found or status changed concurrently"
            : "Class not found",
        },
        { status: statusWriteAttempted ? 409 : 404 },
      );
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
                consultantProfile: { include: { user: true } },
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
