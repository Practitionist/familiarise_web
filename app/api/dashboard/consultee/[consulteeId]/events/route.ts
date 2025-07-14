import { NextResponse } from "next/server";

interface ConsulteeEventsData {
  consultations: any[];
  subscriptions: any[];
  webinars: any[];
  classes: any[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  try {
    const { consulteeId } = await params;

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    // Fetch all consultee events in parallel
    const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] =
      await Promise.all([
        fetch(
          `${baseUrl}/api/events/consultations?consulteeProfileId=${consulteeId}`,
        ),
        fetch(
          `${baseUrl}/api/events/subscriptions?consulteeProfileId=${consulteeId}`,
        ),
        fetch(
          `${baseUrl}/api/events/webinars?consulteeProfileId=${consulteeId}`,
        ),
        fetch(
          `${baseUrl}/api/events/classes?consulteeProfileId=${consulteeId}`,
        ),
      ]);

    // Check for errors in any of the responses
    const responses = [
      { name: "consultations", response: consultationsRes },
      { name: "subscriptions", response: subscriptionsRes },
      { name: "webinars", response: webinarsRes },
      { name: "classes", response: classesRes },
    ];

    for (const { name, response } of responses) {
      if (!response.ok) {
        console.error(`Failed to fetch ${name}:`, response.statusText);
        return NextResponse.json(
          { error: `Failed to fetch ${name} data` },
          { status: response.status },
        );
      }
    }

    // Parse all responses
    const [consultationsData, subscriptionsData, webinarsData, classesData] =
      await Promise.all([
        consultationsRes.json(),
        subscriptionsRes.json(),
        webinarsRes.json(),
        classesRes.json(),
      ]);

    const eventsData: ConsulteeEventsData = {
      consultations: consultationsData.data || [],
      subscriptions: subscriptionsData.data || [],
      webinars: webinarsData.data || [],
      classes: classesData.data || [],
    };

    return NextResponse.json({
      data: eventsData,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching consultee events:", error);
    return NextResponse.json(
      { error: "Failed to fetch consultee events" },
      { status: 500 },
    );
  }
}
