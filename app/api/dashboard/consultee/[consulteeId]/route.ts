import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  try {
    const resolvedParams = await params;
    const { consulteeId } = resolvedParams;

    // Fetch all events data in parallel
    const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] =
      await Promise.all([
        fetch(
          `${request.nextUrl.origin}/api/events/consultations?consulteeProfileId=${consulteeId}`,
          { headers: { Cookie: request.headers.get("cookie") || "" } },
        ),
        fetch(
          `${request.nextUrl.origin}/api/events/subscriptions?consulteeProfileId=${consulteeId}`,
          { headers: { Cookie: request.headers.get("cookie") || "" } },
        ),
        fetch(
          `${request.nextUrl.origin}/api/events/webinars?consulteeProfileId=${consulteeId}`,
          { headers: { Cookie: request.headers.get("cookie") || "" } },
        ),
        fetch(
          `${request.nextUrl.origin}/api/events/classes?consulteeProfileId=${consulteeId}`,
          { headers: { Cookie: request.headers.get("cookie") || "" } },
        ),
      ]);

    // Check for errors
    if (!consultationsRes.ok) {
      throw new Error(
        `Failed to fetch consultations: ${consultationsRes.statusText}`,
      );
    }
    if (!subscriptionsRes.ok) {
      throw new Error(
        `Failed to fetch subscriptions: ${subscriptionsRes.statusText}`,
      );
    }
    if (!webinarsRes.ok) {
      throw new Error(`Failed to fetch webinars: ${webinarsRes.statusText}`);
    }
    if (!classesRes.ok) {
      throw new Error(`Failed to fetch classes: ${classesRes.statusText}`);
    }

    // Parse responses
    const consultationsData = await consultationsRes.json();
    const subscriptionsData = await subscriptionsRes.json();
    const webinarsData = await webinarsRes.json();
    const classesData = await classesRes.json();

    // Return consolidated response
    return NextResponse.json({
      success: true,
      data: {
        consultations: consultationsData?.data || [],
        subscriptions: subscriptionsData?.data || [],
        webinars: webinarsData?.data || [],
        classes: classesData?.data || [],
      },
    });
  } catch (error) {
    console.error("Error fetching consultee events:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch events data",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
