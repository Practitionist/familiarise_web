import { NextResponse } from "next/server";
import { TWebinar, TClass } from "@/types/appointment";

// Type for webinar events in planner with type discriminator
type WebinarEvent = TWebinar & {
  type: "webinar";
};

// Type for class events in planner with type discriminator
type ClassEvent = TClass & {
  type: "class";
};

interface PlannerData {
  webinars: WebinarEvent[];
  classes: ClassEvent[];
  participantCounts: Record<string, number>;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    // Fetch webinars and classes in parallel
    const [webinarsRes, classesRes] = await Promise.all([
      fetch(
        `${baseUrl}/api/events/webinars?consultantProfileId=${consultantId}`,
      ),
      fetch(
        `${baseUrl}/api/events/classes?consultantProfileId=${consultantId}`,
      ),
    ]);

    // Check for errors in responses
    if (!webinarsRes.ok) {
      console.error("Failed to fetch webinars:", webinarsRes.statusText);
      return NextResponse.json(
        { error: "Failed to fetch webinars" },
        { status: webinarsRes.status },
      );
    }

    if (!classesRes.ok) {
      console.error("Failed to fetch classes:", classesRes.statusText);
      return NextResponse.json(
        { error: "Failed to fetch classes" },
        { status: classesRes.status },
      );
    }

    // Parse responses
    const [webinarsData, classesData] = await Promise.all([
      webinarsRes.json(),
      classesRes.json(),
    ]);

    // Transform webinars to include type discriminator (same as PlannerService.fetchWebinars)
    const webinars: WebinarEvent[] = (webinarsData.data || []).map(
      (webinar: TWebinar) => ({
        ...webinar,
        type: "webinar" as const,
      }),
    );

    // Transform classes to include type discriminator (same as PlannerService.fetchClasses)
    const classes: ClassEvent[] = (classesData.data || []).map(
      (classEvent: TClass) => ({
        ...classEvent,
        type: "class" as const,
      }),
    );

    // Fetch participant counts for all events in parallel
    const participantCountPromises = [
      ...webinars.map(async (webinar: WebinarEvent) => {
        try {
          const response = await fetch(
            `${baseUrl}/api/participants/webinar/${webinar.id}`,
          );
          if (response.ok) {
            const data = await response.json();
            return {
              eventId: webinar.id,
              count: data.participants?.length || 0,
            };
          }
        } catch (error) {
          console.error(
            `Failed to fetch participants for webinar ${webinar.id}:`,
            error,
          );
        }
        return { eventId: webinar.id, count: 0 };
      }),
      ...classes.map(async (classEvent: ClassEvent) => {
        try {
          const response = await fetch(
            `${baseUrl}/api/participants/class/${classEvent.id}`,
          );
          if (response.ok) {
            const data = await response.json();
            return {
              eventId: classEvent.id,
              count: data.participants?.length || 0,
            };
          }
        } catch (error) {
          console.error(
            `Failed to fetch participants for class ${classEvent.id}:`,
            error,
          );
        }
        return { eventId: classEvent.id, count: 0 };
      }),
    ];

    const participantCountResults = await Promise.all(participantCountPromises);
    const participantCounts: Record<string, number> = {};
    participantCountResults.forEach(({ eventId, count }) => {
      participantCounts[eventId] = count;
    });

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
