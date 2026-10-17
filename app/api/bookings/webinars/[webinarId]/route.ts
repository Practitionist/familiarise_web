import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  authorizeEventAccess,
} from "@/lib/auth-helpers";
import { WebinarInstanceUpdateSchema } from "@/schemas/event-instance";
import { PROFILE_WITH_USER_SELECT } from "@/lib/booking/list-selects";
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

    const authz = await authorizeEventAccess(
      session,
      "webinar",
      webinarId,
      request.method,
    );
    if (authz) return authz;

    const webinarData = await prisma.webinar.findUniqueOrThrow({
      where: { id: webinarId },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: PROFILE_WITH_USER_SELECT,
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

  try {
    const { webinarId } = await params;
    const parsed = WebinarInstanceUpdateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid webinar update", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    // Cancellation owns refunds and history, so status never changes here.
    if (parsed.data.status !== undefined) {
      return NextResponse.json(
        {
          error: "Cancel a webinar through its cancel action, not an update.",
          code: "USE_CANCEL_ROUTE",
        },
        { status: 409 },
      );
    }

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
      data: { feedbackSummary: parsed.data.feedbackSummary },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: PROFILE_WITH_USER_SELECT,
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

    // Ownership first, so a stranger cannot hold the buyers' checkout lock
    // for this event by calling DELETE in a loop.
    const mine = await prisma.webinar.findFirst({
      where: owned,
      select: { id: true },
    });
    if (!mine) {
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }

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
                consultantProfile: PROFILE_WITH_USER_SELECT,
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
