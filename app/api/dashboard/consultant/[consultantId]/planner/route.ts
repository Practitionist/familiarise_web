import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { transformNestedPlanTopics } from "@/lib/topics";

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
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // Fetch webinar participant counts in a single query
  if (webinarIds.length > 0) {
    const webinarCounts = await prisma.webinar.findMany({
      where: { id: { in: webinarIds } },
      select: {
        id: true,
        appointment: {
          select: {
            slotsOfAppointment: {
              select: { _count: { select: { user: true } } },
              where: { isTentative: false },
            },
          },
        },
      },
    });

    for (const webinar of webinarCounts) {
      counts[webinar.id] =
        webinar.appointment?.slotsOfAppointment.reduce(
          (total, slot) => total + slot._count.user,
          0,
        ) || 0;
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
      const uniqueUserIds = new Set<string>();

      for (const appointment of classEvent.appointments) {
        for (const slot of appointment.slotsOfAppointment) {
          // slot.user is an array of users connected to this slot
          for (const user of slot.user) {
            uniqueUserIds.add(user.id);
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
  // Note: request parameter kept for Next.js API route signature compatibility
  void request;

  try {
    const { consultantId } = await params;

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

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
        where: { webinarPlan: { consultantProfileId: consultantId } },
        include: webinarInclude,
      }),
      prisma.class.findMany({
        where: { classPlan: { consultantProfileId: consultantId } },
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

    const participantCounts = await getParticipantCounts(webinarIds, classIds);

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
