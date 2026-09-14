import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
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
        return forbiddenResponse("You can only view your own enrolled classes");
      }
      if (
        consultantProfileId &&
        session.user.consultantProfileId !== consultantProfileId
      ) {
        return forbiddenResponse("You can only view your own classes");
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
            "You are not authorized to view classes without a profile",
          );
        }
      }
    }
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    // Org-scope filter — Class rows don't carry organizationId directly;
    // attribution lives on the parent CohortPlan (per
    // `docs/enterprise/30-programs-and-lifecycle/05-public-pages-and-discovery.md`
    // — plans with `organizationId` set are the org's catalog). So we
    // filter via the `cohortPlan.organizationId` relation.
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
      // "all of MY classes" — safe for any role.
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
    const cohortPlanOrgWhere: Prisma.CohortPlanWhereInput | null =
      scopeResolution.scope.kind === "personal"
        ? { organizationId: null }
        : scopedOrgId
          ? { organizationId: scopedOrgId }
          : null; // "all" → no filter

    let cohorts;

    const dateFilter =
      startDateStr && endDateStr
        ? {
            // Filter classes where the class's own start date falls within the range
            schedulingPeriodStartsAt: {
              gte: new Date(startDateStr),
              lte: new Date(endDateStr),
            },
          }
        : {};

    if (consulteeProfileId) {
      cohorts = await prisma.cohort.findMany({
        where: {
          ...(cohortPlanOrgWhere && { cohortPlan: cohortPlanOrgWhere }),
          OR: [
            // Get classes where consultee is registered through appointments
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
          cohortPlan: {
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
              cohortContents: {
                orderBy: {
                  order: "asc",
                },
              },
            },
          },
          appointment: {
            include: {
              occurrences: true,
              payment: true,
            },
          },
        },
        orderBy: [
          {
            schedulingPeriodStartsAt: "desc",
          },
          {
            status: "asc",
          },
        ],
      });
    } else if (consultantProfileId) {
      cohorts = await prisma.cohort.findMany({
        where: {
          cohortPlan: {
            consultantProfileId,
            ...(cohortPlanOrgWhere ?? {}),
          },
          ...dateFilter,
        },
        include: {
          cohortPlan: {
            include: {
              consultantProfile: { select: consultantPublicScalars },
              topics: true,
              cohortContents: {
                orderBy: {
                  order: "asc",
                },
              },
            },
          },
          // #1346 — the planner card shows a class's first session, so the
          // allocated slots have to travel with the run; `appointment: true`
          // alone left the card falling back to the authoring window.
          appointment: {
            include: {
              occurrences: { orderBy: { startsAt: "asc" } },
            },
          },
        },
      });
    } else {
      cohorts = await prisma.cohort.findMany({
        where: {
          ...(cohortPlanOrgWhere && { cohortPlan: cohortPlanOrgWhere }),
          ...dateFilter,
        },
        include: {
          cohortPlan: {
            include: {
              topics: true,
            },
          },
          appointment: true,
        },
      });
    }

    // Transform topics from objects to strings in nested cohortPlan
    const transformedCohorts = cohorts.map((c) =>
      transformNestedPlanTopics(c, "cohortPlan"),
    );

    return NextResponse.json({ data: transformedCohorts }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error fetching classes:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching classes" },
      { status: 500 },
    );
  }
}
