import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { publicProfileUserSelect } from "@/lib/data/consultant-public";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN/STAFF can list all consultees
    if (!isPrivileged(session.user.role)) {
      return forbiddenResponse(
        "Only administrators and staff can list all consultees",
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    // Calculate offset
    const skip = (page - 1) * limit;

    // ADMIN reads the whole learner record; STAFF read the shared
    // public-field selection, as on the single-learner read.
    const consultees =
      session.user.role === "ADMIN"
        ? await prisma.consulteeProfile.findMany({
            include: {
              consultantReviews: { where: { deletedAt: null } },
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
            skip,
            take: limit,
          })
        : await prisma.consulteeProfile.findMany({
            select: {
              id: true,
              userId: true,
              user: { select: publicProfileUserSelect },
            },
            skip,
            take: limit,
          });

    return NextResponse.json(consultees, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    console.error("Error getting consultees:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
