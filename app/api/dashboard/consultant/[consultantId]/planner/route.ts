import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { transformNestedPlanTopics } from "@/lib/topics";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope, scopeOrgId } from "@/lib/api/scope/parse";

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
          // Display fields only — the full User row per attendee was the
          // planner payload's biggest over-fetch. Slot scalars
          // (isTentative etc.) still come through; the in-memory
          // participant count below relies on them.
          user: { select: { id: true, name: true, email: true, image: true } },
          // #1061 — without this the planner cannot tell that the host has
          // already ended the call, so its Join gate could only ever expire on
          // the clock. Two columns per row.
          meetingSession: { select: { id: true, endedAt: true } },
        },
      },
    },
  },
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

// Derive types from the include objects via the extended client — raw
// GetPayload would re-introduce bigint money fields (#780).
type PlannerWebinar = Prisma.Result<
  typeof prisma.webinar,
  { include: typeof webinarInclude },
  "findFirstOrThrow"
>;
type PlannerClass = Prisma.Result<
  typeof prisma.class,
  { include: typeof classInclude },
  "findFirstOrThrow"
>;

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
 * Webinar participant counts computed from the ALREADY-FETCHED webinar rows
 * (webinarInclude carries appointment.slotsOfAppointment.user) — the old
 * helper re-queried the same rows from Postgres a second time per request.
 * FIX #556 semantics preserved: confirmed (non-tentative) slots only,
 * deduplicated across multi-slot webinars, consultant host excluded.
 */
function countWebinarParticipants(
  webinars: Array<{
    id: string;
    appointment: {
      slotsOfAppointment: Array<{
        isTentative: boolean;
        user: Array<{ id: string }>;
      }>;
    } | null;
  }>,
  excludeConsultantUserId?: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const webinar of webinars) {
    const uniqueUserIds = new Set<string>();
    for (const slot of webinar.appointment?.slotsOfAppointment || []) {
      if (slot.isTentative) continue;
      for (const user of slot.user) {
        if (user.id !== excludeConsultantUserId) {
          uniqueUserIds.add(user.id);
        }
      }
    }
    counts[webinar.id] = uniqueUserIds.size;
  }
  return counts;
}

/**
 * Class participant counts still need their one batched query —
 * classInclude fetches bare appointments without slots (the class payload
 * doesn't show attendees), so the user ids aren't already in memory.
 * FIX #142: batched, never N+1.
 */
async function getClassParticipantCounts(
  classIds: string[],
  excludeConsultantUserId?: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

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
          select: { organizationId: true, status: true, role: true },
        })
      : [];
    const scopeResolution = resolveOrgScope({
      raw: url.searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
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
    // `orgMember` pins an org exactly as `org` does — see scopeOrgId.
    const plannerOrgId = scopeOrgId(scopeResolution.scope);
    const webinarApptOrg: Prisma.WebinarWhereInput | undefined =
      scopeResolution.scope.kind === "personal"
        ? {
            OR: [
              { appointment: { is: null } },
              { appointment: { is: { organizationId: null } } },
            ],
          }
        : plannerOrgId
          ? {
              appointment: {
                is: { organizationId: plannerOrgId },
              },
            }
          : undefined;
    const classApptOrg: Prisma.ClassWhereInput | undefined =
      scopeResolution.scope.kind === "personal"
        ? {
            OR: [
              { appointments: { none: {} } },
              { appointments: { some: { organizationId: null } } },
            ],
          }
        : plannerOrgId
          ? {
              appointments: {
                some: { organizationId: plannerOrgId },
              },
            }
          : undefined;

    // Fetch owned plans, collaborated plans, and collaborator roles in parallel
    const [
      ownedWebinarsRaw,
      ownedClassesRaw,
      collabWebinarsRaw,
      collabClassesRaw,
      collabRoles,
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
      // Collaborator role lookups (#784 — one merged model for both plan types)
      prisma.collaborator.findMany({
        where: { consultantProfileId: consultantId, status: "ACCEPTED" },
        select: { webinarPlanId: true, classPlanId: true, role: true },
      }),
    ]);

    // Build role lookup maps — exactly one plan FK is set per record (#784)
    const webinarRoleMap: Record<string, string> = {};
    const classRoleMap: Record<string, string> = {};
    for (const c of collabRoles) {
      if (c.webinarPlanId) webinarRoleMap[c.webinarPlanId] = c.role;
      else if (c.classPlanId) classRoleMap[c.classPlanId] = c.role;
    }

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

    // Participant counts for all events (owned + collaborated).
    // FIX #556: the consultant's own userId is excluded — reuse the
    // consultantUser already fetched for org-scope resolution above (the
    // old code re-fetched the identical row here).
    const classIds = classes.map((c) => c.id);
    const participantCounts = {
      ...countWebinarParticipants(webinars, consultantUser?.userId),
      ...(await getClassParticipantCounts(classIds, consultantUser?.userId)),
    };

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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching planner data:", error);
    return NextResponse.json(
      { error: "Failed to fetch planner data" },
      { status: 500 },
    );
  }
}
