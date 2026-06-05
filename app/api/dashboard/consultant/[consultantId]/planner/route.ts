import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { transformNestedPlanTopics } from "@/lib/topics";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope } from "@/lib/api/scope/parse";

// =============================================================================
// Prisma Query Types - Derived from actual query shape for type safety
// =============================================================================

const webinarInclude = {
  webinarPlan: {
    include: {
      consultantProfile: true,
      topics: true,
    },
  },
  appointment: {
    include: {
      slotsOfAppointment: {
        include: {
          user: true,
        },
      },
    },
  },
  waitlist: true,
} satisfies Prisma.WebinarInclude;

const classInclude = {
  classPlan: {
    include: {
      consultantProfile: true,
      topics: true,
      classContents: {
        orderBy: {
          order: "asc" as const,
        },
      },
    },
  },
  appointments: true,
} satisfies Prisma.ClassInclude;

// Derive types from the include objects
type PlannerWebinar = Prisma.WebinarGetPayload<{
  include: typeof webinarInclude;
}>;
type PlannerClass = Prisma.ClassGetPayload<{ include: typeof classInclude }>;

// Response types with discriminators and role annotations
type WebinarEvent = PlannerWebinar & {
  type: "webinar";
  collaboratorRole: string;
  isCollaborated: boolean;
};
type ClassEvent = PlannerClass & {
  type: "class";
  collaboratorRole: string;
  isCollaborated: boolean;
};

interface PlannerData {
  webinars: WebinarEvent[];
  classes: ClassEvent[];
  participantCounts: Record<string, number>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Helper function to fetch participant counts directly via Prisma
 * FIX #142: Uses batched queries instead of N+1 individual API calls
 */
async function getParticipantCounts(
  webinarIds: string[],
  classIds: string[],
  excludeConsultantUserId?: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // FIX #556: Fetch webinar participant counts with host exclusion.
  // Use actual user IDs (not _count) to deduplicate across multi-slot
  // webinars and exclude the consultant host.
  if (webinarIds.length > 0) {
    const webinarCounts = await prisma.webinar.findMany({
      where: { id: { in: webinarIds } },
      select: {
        id: true,
        appointment: {
          select: {
            slotsOfAppointment: {
              select: {
                user: { select: { id: true } },
              },
              where: { isTentative: false },
            },
          },
        },
      },
    });

    for (const webinar of webinarCounts) {
      const uniqueUserIds = new Set<string>();
      for (const slot of webinar.appointment?.slotsOfAppointment || []) {
        for (const user of slot.user) {
          if (user.id !== excludeConsultantUserId) {
            uniqueUserIds.add(user.id);
          }
        }
      }
      counts[webinar.id] = uniqueUserIds.size;
    }
  }

  // Fetch class participant counts - count UNIQUE users across all sessions
  if (classIds.length > 0) {
    const classCounts = await prisma.class.findMany({
      where: { id: { in: classIds } },
      select: {
        id: true,
        appointments: {
          select: {
            slotsOfAppointment: {
              select: {
                user: {
                  select: { id: true },
                },
              },
              where: { isTentative: false },
            },
          },
        },
      },
    });

    for (const classEvent of classCounts) {
      // Use a Set to count unique users across ALL appointments/sessions
      // FIX #556: Exclude the consultant host from participant count
      const uniqueUserIds = new Set<string>();

      for (const appointment of classEvent.appointments) {
        for (const slot of appointment.slotsOfAppointment) {
          for (const user of slot.user) {
            if (user.id !== excludeConsultantUserId) {
              uniqueUserIds.add(user.id);
            }
          }
        }
      }

      counts[classEvent.id] = uniqueUserIds.size;
    }
  }

  return counts;
}

// =============================================================================
// Route Handler
// =============================================================================

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consultantId } = await params;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consultantProfileId !== consultantId
    ) {
      return forbiddenResponse("You can only access your own planner");
    }

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    // B1-personal-retrofit: parse + authorize ?orgScope=. Filter applies
    // to the appointment.organizationId attached to each Webinar/Class.
    // Plans without bookings yet are NOT filtered (the planner shows
    // owned + collaborated plans regardless of whether anyone has
    // booked them).
    const url = new URL(request.url);
    const consultantUser = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { userId: true },
    });
    const callerMemberships = consultantUser
      ? await prisma.membership.findMany({
          where: { userId: consultantUser.userId, status: "ACTIVE" },
          select: { organizationId: true, status: true },
        })
      : [];
    const scopeResolution = resolveOrgScope({
      raw: url.searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      // Self-scoped consultant endpoint.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }
    // For Webinar (1:1 appointment) — `appointment.is.organizationId`.
    // For Class (1:many appointments) — `appointments.some.organizationId`.
    //
    // Personal scope: include events that have NO appointment yet (unbooked)
    // OR have an appointment with organizationId=null. Using only
    // `{ appointment: { is: { organizationId: null } } }` would exclude
    // freshly created unbooked events, hiding them from the consultant's
    // own inventory view. Issue: #732 (planner inventory vs booking-history
    // semantics — flagged in the May 2026 readiness audit).
    const webinarApptOrg: Prisma.WebinarWhereInput | undefined =
      scopeResolution.scope.kind === "personal"
        ? {
            OR: [
              { appointment: { is: null } },
              { appointment: { is: { organizationId: null } } },
            ],
          }
        : scopeResolution.scope.kind === "org"
          ? { appointment: { is: { organizationId: scopeResolution.scope.orgId } } }
          : undefined;
    const classApptOrg: Prisma.ClassWhereInput | undefined =
      scopeResolution.scope.kind === "personal"
        ? {
            OR: [
              { appointments: { none: {} } },
              { appointments: { some: { organizationId: null } } },
            ],
          }
        : scopeResolution.scope.kind === "org"
          ? {
              appointments: {
                some: { organizationId: scopeResolution.scope.orgId },
              },
            }
          : undefined;

    // Fetch owned plans, collaborated plans, and collaborator roles in parallel
    const [
      ownedWebinarsRaw,
      ownedClassesRaw,
      collabWebinarsRaw,
      collabClassesRaw,
      webinarCollabRoles,
      classCollabRoles,
    ] = await Promise.all([
      // Owned plans
      prisma.webinar.findMany({
        where: {
          webinarPlan: { consultantProfileId: consultantId },
          ...(webinarApptOrg ?? {}),
        },
        include: webinarInclude,
      }),
      prisma.class.findMany({
        where: {
          classPlan: { consultantProfileId: consultantId },
          ...(classApptOrg ?? {}),
        },
        include: classInclude,
      }),
      // Collaborated plans (only ACCEPTED)
      prisma.webinar.findMany({
        where: {
          webinarPlan: {
            collaborators: {
              some: { consultantProfileId: consultantId, status: "ACCEPTED" },
            },
          },
          ...(webinarApptOrg ?? {}),
        },
        include: webinarInclude,
      }),
      prisma.class.findMany({
        where: {
          classPlan: {
            collaborators: {
              some: { consultantProfileId: consultantId, status: "ACCEPTED" },
            },
          },
          ...(classApptOrg ?? {}),
        },
        include: classInclude,
      }),
      // Collaborator role lookups
      prisma.webinarCollaborator.findMany({
        where: { consultantProfileId: consultantId, status: "ACCEPTED" },
        select: { webinarPlanId: true, role: true },
      }),
      prisma.classCollaborator.findMany({
        where: { consultantProfileId: consultantId, status: "ACCEPTED" },
        select: { classPlanId: true, role: true },
      }),
    ]);

    // Build role lookup maps
    const webinarRoleMap = Object.fromEntries(
      webinarCollabRoles.map((c) => [c.webinarPlanId, c.role]),
    );
    const classRoleMap = Object.fromEntries(
      classCollabRoles.map((c) => [c.classPlanId, c.role]),
    );

    // Collect owned IDs for deduplication
    const ownedWebinarIds = new Set(ownedWebinarsRaw.map((w) => w.id));
    const ownedClassIds = new Set(ownedClassesRaw.map((c) => c.id));

    // Filter out any collaborated plans that are also owned (defensive)
    const uniqueCollabWebinars = collabWebinarsRaw.filter(
      (w) => !ownedWebinarIds.has(w.id),
    );
    const uniqueCollabClasses = collabClassesRaw.filter(
      (c) => !ownedClassIds.has(c.id),
    );

    // Transform topics and annotate with roles
    const webinars: WebinarEvent[] = [
      ...ownedWebinarsRaw.map((w) => ({
        ...transformNestedPlanTopics(w, "webinarPlan"),
        type: "webinar" as const,
        collaboratorRole: "HOST",
        isCollaborated: false,
      })),
      ...uniqueCollabWebinars.map((w) => ({
        ...transformNestedPlanTopics(w, "webinarPlan"),
        type: "webinar" as const,
        collaboratorRole: webinarRoleMap[w.webinarPlanId] || "COLLABORATOR",
        isCollaborated: true,
      })),
    ];

    const classes: ClassEvent[] = [
      ...ownedClassesRaw.map((c) => ({
        ...transformNestedPlanTopics(c, "classPlan"),
        type: "class" as const,
        collaboratorRole: "HOST",
        isCollaborated: false,
      })),
      ...uniqueCollabClasses.map((c) => ({
        ...transformNestedPlanTopics(c, "classPlan"),
        type: "class" as const,
        collaboratorRole: classRoleMap[c.classPlanId] || "COLLABORATOR",
        isCollaborated: true,
      })),
    ];

    // Fetch participant counts for all events (owned + collaborated)
    const webinarIds = webinars.map((w) => w.id);
    const classIds = classes.map((c) => c.id);

    // FIX #556: Pass consultant's userId to exclude from participant counts
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { userId: true },
    });
    const participantCounts = await getParticipantCounts(
      webinarIds,
      classIds,
      consultantProfile?.userId,
    );

    const plannerData: PlannerData = {
      webinars,
      classes,
      participantCounts,
    };

    return NextResponse.json({
      data: plannerData,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching planner data:", error);
    return NextResponse.json(
      { error: "Failed to fetch planner data" },
      { status: 500 },
    );
  }
}
