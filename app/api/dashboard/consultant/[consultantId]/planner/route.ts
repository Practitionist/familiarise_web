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
type PlannerWebinar = Prisma.WebinarGetPayload<{ include: typeof webinarInclude }>;
type PlannerClass = Prisma.ClassGetPayload<{ include: typeof classInclude }>;

// Response types with discriminators
type WebinarEvent = PlannerWebinar & { type: "webinar" };
type ClassEvent = PlannerClass & { type: "class" };

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

    // PERFORMANCE FIX #364: Use direct Prisma queries instead of internal HTTP fetches
    // This eliminates network overhead and reduces response time significantly
    const [webinarsRaw, classesRaw] = await Promise.all([
      prisma.webinar.findMany({
        where: {
          webinarPlan: {
            consultantProfileId: consultantId,
          },
        },
        include: webinarInclude,
      }),
      prisma.class.findMany({
        where: {
          classPlan: {
            consultantProfileId: consultantId,
          },
        },
        include: classInclude,
      }),
    ]);

    // Transform topics from objects to strings in nested plans (matching original API behavior)
    const transformedWebinars = webinarsRaw.map((w) =>
      transformNestedPlanTopics(w, "webinarPlan"),
    );
    const transformedClasses = classesRaw.map((c) =>
      transformNestedPlanTopics(c, "classPlan"),
    );

    // Transform to include type discriminator
    const webinars: WebinarEvent[] = transformedWebinars.map((webinar) => ({
      ...webinar,
      type: "webinar" as const,
    }));

    const classes: ClassEvent[] = transformedClasses.map((classEvent) => ({
      ...classEvent,
      type: "class" as const,
    }));

    // FIX #142: Fetch participant counts using direct Prisma query (not internal API)
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
