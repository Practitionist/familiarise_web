import prisma from "@/lib/prisma";
import { Prisma, TrialSessionStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { logTrialRequested } from "@/lib/activity/log-activity";
import { notifyTrialSessionRequested } from "@/lib/novu";
import { CreateTrialSchema } from "@/schemas/trials";
import { getSession } from "@/lib/auth-server";
import { trialRequestLimiter, applyRateLimit } from "@/lib/rate-limit";
import { resolveOrgScope } from "@/lib/api/scope/parse";

/**
 * GET /api/trials
 * List trial sessions with optional filters
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let consultantProfileId = searchParams.get("consultantProfileId");
  let consulteeProfileId = searchParams.get("consulteeProfileId");
  const subscriptionPlanId = searchParams.get("subscriptionPlanId");
  const status = searchParams.get("status") as TrialSessionStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "requestedAt";
  const sortOrder = searchParams.get("sortOrder") || "desc";

  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";

    // Auto-infer profile filter for non-privileged users
    if (!isPrivileged) {
      if (session.user.role === "CONSULTANT") {
        // Verify consultant has a valid profile
        if (!session.user.consultantProfileId) {
          return NextResponse.json(
            {
              error:
                "Consultant profile not configured. Please complete onboarding.",
            },
            { status: 422 },
          );
        }
        // Auto-set filter to own profile if not specified
        if (!consultantProfileId) {
          consultantProfileId = session.user.consultantProfileId;
        } else if (session.user.consultantProfileId !== consultantProfileId) {
          // Reject if trying to access another consultant's trials
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      } else if (session.user.role === "CONSULTEE") {
        // Verify consultee has a valid profile
        if (!session.user.consulteeProfileId) {
          return NextResponse.json(
            {
              error:
                "Consultee profile not configured. Please complete onboarding.",
            },
            { status: 422 },
          );
        }
        // Auto-set filter to own profile if not specified
        if (!consulteeProfileId) {
          consulteeProfileId = session.user.consulteeProfileId;
        } else if (session.user.consulteeProfileId !== consulteeProfileId) {
          // Reject if trying to access another consultee's trials
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      } else {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // #674 org-scope filter. TrialSession.organizationId is populated by
    // the backfill — keeps Acme-context views from leaking Zeta trial
    // bookings into the consultant's "Trials" tab.
    const callerMemberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }

    const whereClause: Prisma.TrialSessionWhereInput =
      scopeResolution.scope.kind === "personal"
        ? { organizationId: null }
        : scopeResolution.scope.kind === "org"
          ? { organizationId: scopeResolution.scope.orgId }
          : {};

    if (consultantProfileId) {
      whereClause.consultantProfileId = consultantProfileId;
    }

    if (consulteeProfileId) {
      whereClause.consulteeProfileId = consulteeProfileId;
    }

    if (subscriptionPlanId) {
      whereClause.subscriptionPlanId = subscriptionPlanId;
    }

    if (status) {
      whereClause.status = status;
    }

    if (search) {
      whereClause.OR = [
        {
          consulteeProfile: {
            user: { name: { contains: search, mode: "insensitive" } },
          },
        },
        {
          consulteeProfile: {
            user: { email: { contains: search, mode: "insensitive" } },
          },
        },
      ];
    }

    // Dynamic orderBy mapping
    const orderByMap: Record<
      string,
      Prisma.TrialSessionOrderByWithRelationInput
    > = {
      requestedAt: { requestedAt: sortOrder as "asc" | "desc" },
      status: { status: sortOrder as "asc" | "desc" },
      name: {
        consulteeProfile: { user: { name: sortOrder as "asc" | "desc" } },
      },
      plan: { subscriptionPlan: { title: sortOrder as "asc" | "desc" } },
    };
    const orderBy = orderByMap[sortBy] || orderByMap.requestedAt;

    const [trialSessions, total] = await Promise.all([
      prisma.trialSession.findMany({
        where: whereClause,
        include: {
          consulteeProfile: {
            include: {
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
          consultantProfile: {
            include: {
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
          subscriptionPlan: true,
          appointment: {
            include: {
              slotsOfAppointment: true,
            },
          },
          convertedToSubscription: true,
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.trialSession.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: trialSessions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching trial sessions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial sessions" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/trials
 * Request a new trial session
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const result = CreateTrialSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const {
      consulteeProfileId,
      consultantProfileId,
      subscriptionPlanId,
      notes,
      organizationId,
    } = result.data;

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (!isPrivileged) {
      if (
        session.user.role !== "CONSULTEE" ||
        session.user.consulteeProfileId !== consulteeProfileId
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      // Rate limit: 3 trial requests per 24 hours per consultee (prevents inbox flooding)
      const rl = await applyRateLimit(trialRequestLimiter, session.user.id);
      if (rl) return rl;
    }

    // Check if a trial already exists for this consultee-consultant pair
    const existingTrial = await prisma.trialSession.findUnique({
      where: {
        consulteeProfileId_consultantProfileId: {
          consulteeProfileId,
          consultantProfileId,
        },
      },
    });

    if (existingTrial) {
      return NextResponse.json(
        { error: "You have already requested a trial with this consultant" },
        { status: 409 },
      );
    }

    // Verify the subscription plan exists and has free trial enabled
    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!subscriptionPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (subscriptionPlan.consultantProfileId !== consultantProfileId) {
      return NextResponse.json(
        { error: "Subscription plan does not belong to this consultant" },
        { status: 400 },
      );
    }

    if (!subscriptionPlan.freeTrialEnabled) {
      return NextResponse.json(
        { error: "Free trial is not available for this plan" },
        { status: 400 },
      );
    }

    // Get consultee info for activity log
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeProfileId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // Enterprise: if the caller passed `organizationId`, verify they're
    // an ACTIVE LEARNER (or higher) member of that org before we stamp
    // attribution. Trials are free, so this is org-tagging for analytics
    // (conversion-rate per org) — never a payment claim. Silently
    // dropping the field on membership mismatch would let a curious
    // user forge org-tagged trial attribution; we return 403 instead so
    // the client bug becomes obvious. `findFirst` with `userId`
    // resolves against the BetterAuth User id on the session.
    let resolvedOrgId: string | null = null;
    if (organizationId) {
      const membership = await prisma.membership.findFirst({
        where: {
          organizationId,
          userId: session.user.id,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!membership) {
        return NextResponse.json(
          {
            error:
              "You are not an active member of the specified organization.",
          },
          { status: 403 },
        );
      }
      resolvedOrgId = organizationId;
    }

    // Create the trial session
    const trialSession = await prisma.trialSession.create({
      data: {
        consulteeProfileId,
        consultantProfileId,
        subscriptionPlanId,
        notes,
        status: TrialSessionStatus.PENDING,
        organizationId: resolvedOrgId,
      },
      include: {
        consulteeProfile: {
          include: {
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
        consultantProfile: {
          include: {
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
        subscriptionPlan: true,
      },
    });

    // Log the activity
    await logTrialRequested(
      consultantProfileId,
      trialSession.id,
      {
        id: consulteeProfile.user.id,
        name: consulteeProfile.user.name,
        image: consulteeProfile.user.image,
      },
      subscriptionPlan.title,
    );

    // Notify the consultant about the new trial request
    void notifyTrialSessionRequested(trialSession.consultantProfile.user.id, {
      consultantName: trialSession.consultantProfile.user.name || "Consultant",
      consulteeName: trialSession.consulteeProfile.user.name || "User",
      planTitle: subscriptionPlan.title,
      status: trialSession.status,
      dashboardUrl: "/dashboard/consultant/trials",
    });

    return NextResponse.json({ data: trialSession }, { status: 201 });
  } catch (error) {
    console.error("Error creating trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while creating trial session" },
      { status: 500 },
    );
  }
}
