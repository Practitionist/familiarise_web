import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma, WebinarStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  authorizeEventAccess,
} from "@/lib/auth-helpers";
import { EVENT_ALLOWED_FROM } from "@/lib/booking/transitions";
import {
  deleteUntouchedOffering,
  offeringDeleteRefusal,
  OfferingInUseError,
  UNTOUCHED_EVENT,
} from "@/lib/booking/offering-delete";

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
            occurrences: {
              include: {
                // Changed from consulteeProfile to user
              },
            },
          },
        },
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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

  // Set once a guarded status write is attempted; lets the P2025 handler
  // below distinguish a CAS-guard miss (409) from a missing row (404).
  let statusWriteAttempted = false;

  try {
    const { webinarId } = await params;
    const body = await request.json();

    // Doctrine #1 — status writes go through the CAS map. `body.status` used
    // to be written raw, so an owner could drive illegal edges
    // (CANCELLED → SCHEDULED resurrection, DRAFT → COMPLETED) that
    // EVENT_ALLOWED_FROM exists to prevent. The allowed-from set rides the
    // UPDATE's WHERE below, so a racing transition matches zero rows.
    const requestedStatus =
      typeof body.status === "string"
        ? (body.status as WebinarStatus)
        : undefined;
    if (
      requestedStatus &&
      !Object.values(WebinarStatus).includes(requestedStatus)
    ) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    let allowedFrom: WebinarStatus[] | null = null;
    if (requestedStatus) {
      const current = await prisma.webinar.findUnique({
        where: { id: webinarId },
        select: { status: true },
      });
      if (!current) {
        return NextResponse.json(
          { error: "Webinar not found" },
          { status: 404 },
        );
      }
      allowedFrom = EVENT_ALLOWED_FROM[requestedStatus];
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
        ...(requestedStatus && allowedFrom
          ? { status: { in: allowedFrom } }
          : {}),
      },
      data: {
        status: requestedStatus,
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
            occurrences: {
              include: {
                // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      // A WHERE miss can be either "no such webinar" or "the status moved
      // between our read and this write" — the latter is the CAS guard
      // working and must surface as 409, not a phantom 404.
      return NextResponse.json(
        {
          error: statusWriteAttempted
            ? "Webinar not found or status changed concurrently"
            : "Webinar not found",
        },
        { status: statusWriteAttempted ? 409 : 404 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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

    // Only the owning consultant or ADMIN/STAFF may delete an instance. The
    // same filter scopes the read and the delete, so a foreign id is a 404
    // rather than an existence oracle.
    const owned = {
      id: webinarId,
      ...(isPrivileged(session.user.role)
        ? {}
        : {
            webinarPlan: {
              consultantProfileId:
                session.user.consultantProfileId ?? "__none__",
            },
          }),
    };

    // #1846 CT-02 — Delete only while nobody has booked or paid (#1527
    // decision 6). The guard counts payments of EVERY status, since a
    // PENDING or FAILED Payment cascades with the appointment as surely as a
    // captured one, and it rides the DELETE's WHERE in one Serializable
    // transaction under the event's checkout lock
    // (lib/booking/offering-delete.ts). An unsold upcoming instance is
    // deletable now; anything ever booked is archived instead.
    const webinarData = await deleteUntouchedOffering(
      "WEBINAR",
      webinarId,
      async (tx) => {
        const row = await tx.webinar.findFirst({
          where: owned,
          include: {
            webinarPlan: {
              include: {
                topics: true,
                consultantProfile: { include: { user: true } },
              },
            },
            appointment: { include: { occurrences: true } },
          },
        });
        if (!row) return null;
        const { count } = await tx.webinar.deleteMany({
          where: { ...owned, ...UNTOUCHED_EVENT },
        });
        if (count === 0) throw new OfferingInUseError("WEBINAR");
        return row;
      },
    );
    if (!webinarData) {
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    const refusal = offeringDeleteRefusal(error);
    if (refusal) {
      return NextResponse.json(refusal.body, { status: refusal.status });
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error deleting webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the webinar" },
      { status: 500 },
    );
  }
}
