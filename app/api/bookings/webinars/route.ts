import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { transformNestedPlanTopics } from "@/lib/topics";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope, scopeOrgId } from "@/lib/api/scope/parse";
import { consultantPublicScalars } from "@/lib/data/consultant-public";

export async function GET(request: NextRequest) {
  // Require authentication (middleware already enforces cookie presence for /api/bookings/)
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { searchParams } = new URL(request.url);
    let consulteeProfileId = searchParams.get("consulteeProfileId");
    let consultantProfileId = searchParams.get("consultantProfileId");

    // IDOR protection: non-privileged users can only request their own profile's data
    if (!isPrivileged(session.user.role)) {
      if (
        consulteeProfileId &&
        session.user.consulteeProfileId !== consulteeProfileId
      ) {
        return forbiddenResponse(
          "You can only view your own enrolled webinars",
        );
      }
      if (
        consultantProfileId &&
        session.user.consultantProfileId !== consultantProfileId
      ) {
        return forbiddenResponse("You can only view your own webinars");
      }
      // No-filter fallthrough guard: auto-fill from session so the unfiltered else
      // branch is never reached by non-privileged users with no params supplied.
      if (!consulteeProfileId && !consultantProfileId) {
        if (session.user.consulteeProfileId) {
          consulteeProfileId = session.user.consulteeProfileId;
        } else if (session.user.consultantProfileId) {
          consultantProfileId = session.user.consultantProfileId;
        } else {
          // User has no profile (e.g. incomplete onboarding) — must not reach unfiltered query
          return forbiddenResponse(
            "You are not authorized to view webinars without a profile",
          );
        }
      }
    }
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");
    // #1592 A-P1-04 — an unparsable date used to reach Prisma as Invalid Date
    // and 500; refuse it as the caller's fault.
    if (
      (startDateStr && isNaN(new Date(startDateStr).getTime())) ||
      (endDateStr && isNaN(new Date(endDateStr).getTime()))
    ) {
      return NextResponse.json(
        {
          error: "startDate and endDate must be valid dates",
          code: "INVALID_DATE",
        },
        { status: 400 },
      );
    }

    // Org-scope filter — Webinar rows don't carry organizationId directly;
    // attribution lives on the parent WebinarPlan (per
    // `docs/enterprise/30-programs-and-lifecycle/05-public-pages-and-discovery.md`
    // — plans with `organizationId` set are the org's catalog). So we
    // filter via the `webinarPlan.organizationId` relation.
    const callerMemberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true, role: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Self-scoped: non-admin callers are already locked to their own
      // consultant/consulteeProfileId above, so `?orgScope=all` means
      // "all of MY webinars" — safe for any role.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }
    // `orgMember` pins an org exactly as `org` does — see scopeOrgId.
    const scopedOrgId = scopeOrgId(scopeResolution.scope);
    const webinarPlanOrgWhere: Prisma.WebinarPlanWhereInput | null =
      scopeResolution.scope.kind === "personal"
        ? { organizationId: null }
        : scopedOrgId
          ? { organizationId: scopedOrgId }
          : null; // "all" → no filter

    let webinars;

    const dateFilter =
      startDateStr && endDateStr
        ? {
            appointment: {
              occurrences: {
                some: {
                  startsAt: {
                    gte: new Date(startDateStr),
                    lte: new Date(endDateStr),
                  },
                },
              },
            },
          }
        : {};

    if (consulteeProfileId) {
      webinars = await prisma.webinar.findMany({
        where: {
          ...(webinarPlanOrgWhere && { webinarPlan: webinarPlanOrgWhere }),
          OR: [
            // Get webinars where consultee is registered through appointments
            {
              appointment: {
                participants: {
                  some: {
                    ...liveParticipant(),
                    user: { consulteeProfile: { id: consulteeProfileId } },
                  },
                },
              },
            },
          ],
          ...dateFilter,
        },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                select: {
                  ...consultantPublicScalars,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                      image: true,
                    },
                  },
                },
              },
              topics: true,
            },
          },
          appointment: {
            include: {
              occurrences: true,
              payment: true,
            },
          },
        },
      });
    } else if (consultantProfileId) {
      const whereClause: Prisma.WebinarWhereInput = {
        webinarPlan: {
          consultantProfileId,
          ...(webinarPlanOrgWhere ?? {}),
        },
      };

      if (startDateStr && endDateStr) {
        whereClause.appointment = {
          occurrences: {
            some: {
              startsAt: {
                gte: new Date(startDateStr),
                lte: new Date(endDateStr),
              },
            },
          },
        };
      }

      webinars = await prisma.webinar.findMany({
        where: whereClause,
        include: {
          webinarPlan: {
            include: {
              consultantProfile: { select: consultantPublicScalars },
              topics: true,
            },
          },
          appointment: {
            include: {
              occurrences: true,
            },
          },
        },
      });
    } else {
      webinars = await prisma.webinar.findMany({
        where: {
          ...(webinarPlanOrgWhere && { webinarPlan: webinarPlanOrgWhere }),
          ...dateFilter,
        },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: { select: consultantPublicScalars },
              topics: true,
            },
          },
          appointment: {
            include: {
              occurrences: true,
            },
          },
        },
      });
    }

    // Transform topics from objects to strings in nested webinarPlan
    const transformedWebinars = webinars.map((w) =>
      transformNestedPlanTopics(w, "webinarPlan"),
    );

    return NextResponse.json({ data: transformedWebinars }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error fetching webinars:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinars" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  // #1583 B-P0-05: the legacy create required scheduledAt/endAt, wrote neither,
  // and trusted body.status. Webinars are created through the offering editor.
  void request;
  return NextResponse.json(
    {
      error:
        "Creating a webinar here is not supported. Use the offering editor " +
        "(POST /api/bookings/webinars/crud-with-plan), which schedules and " +
        "validates the event in one step.",
      code: "LEGACY_CREATE_NOT_SUPPORTED",
    },
    { status: 405 },
  );
}
