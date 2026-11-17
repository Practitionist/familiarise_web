import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  checkOwnership,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { PARTY_USER_SELECT } from "@/lib/booking/list-selects";
import { publicProfileUserSelect } from "@/lib/data/consultant-public";
import { checkConsulteeActiveBookings } from "../../consultants/utils/consultee-bookings";
import { readJsonBody } from "@/lib/api/parse";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const resolvedParams = await params;
    const { id } = resolvedParams;

    // The owner and ADMIN read the whole profile; STAFF read the shared
    // public-field selection; anyone else is refused.
    const isOwner = checkOwnership(session, id, "consultee");
    const fullRead = isOwner || session.user.role === "ADMIN";
    if (!fullRead && !isPrivileged(session.user.role)) {
      return forbiddenResponse(
        "You can only access your own consultee profile",
      );
    }

    const consultee = fullRead
      ? await prisma.consulteeProfile.findUnique({
          where: { id: id },
          include: {
            user: {
              include: {
                workExperiences: {
                  orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
                },
                education: { orderBy: { endYear: "desc" } },
              },
            },
          },
        })
      : await prisma.consulteeProfile.findUnique({
          where: { id: id },
          select: {
            id: true,
            userId: true,
            user: { select: publicProfileUserSelect },
          },
        });

    if (!consultee) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: consultee }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get consultee profile",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const resolvedParams = await params;
    const { id } = resolvedParams;

    // The owner only; operators read a learner's profile but never edit it.
    if (!checkOwnership(session, id, "consultee")) {
      return forbiddenResponse(
        "You can only update your own consultee profile",
      );
    }

    const read = await readJsonBody(req);
    if (read.error) return read.error;
    const body = read.body;

    const existingConsultee = await prisma.consulteeProfile.findUnique({
      where: { id: id },
    });

    if (!existingConsultee) {
      return NextResponse.json(
        { error: "Consultee profile not found for updating" },
        { status: 404 },
      );
    }

    const updatedConsultee = await prisma.consulteeProfile.update({
      where: { id: id },
      data: {
        aboutMe: body.aboutMe,
        preferredLanguage: body.preferredLanguage,
        goals: body.goals,
        careerStage: body.careerStage,
        // An omitted field leaves the stored list as it is.
        skillsToDevelop:
          body.skillsToDevelop === undefined
            ? undefined
            : (body.skillsToDevelop ?? []),
        budgetPreference: body.budgetPreference,
      },
      include: {
        consultantReviews: { where: { deletedAt: null } },
        user: PARTY_USER_SELECT,
      },
    });

    return NextResponse.json(updatedConsultee, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    console.error("Error updating consultee:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while updating the consultee profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { id } = await params;

    // The owner only, like the expert's own profile delete; operators erase
    // accounts through the DPDP request queue.
    const owner = await prisma.consulteeProfile.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!owner || owner.userId !== session.user.id) {
      return forbiddenResponse(
        "You can only delete your own consultee profile",
      );
    }

    const active = await checkConsulteeActiveBookings(id, owner.userId);
    if (active.hasActive) {
      return NextResponse.json(
        {
          error:
            "Cannot delete your learner profile while you have active or upcoming bookings.",
          code: "ACTIVE_APPOINTMENTS_BLOCK_DELETE",
          details: active.details,
        },
        { status: 400 },
      );
    }

    // Refunds, credit usage and invoices all hang off a payment row, so one
    // count covers the buyer's money history; it is kept, never cascaded away.
    const payments = await prisma.payment.count({
      where: { userId: owner.userId },
    });
    if (payments > 0) {
      return NextResponse.json(
        {
          error:
            "Your learner profile has payment history, so it can't be deleted on its own. Delete your account instead; payment records are kept as the law requires.",
          code: "MONEY_HISTORY_BLOCKS_DELETE",
        },
        { status: 400 },
      );
    }

    await prisma.consulteeProfile.delete({ where: { id } });
    return NextResponse.json({ message: "Consultee profile deleted" });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    console.error("Error deleting consultee:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while deleting the consultee profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
