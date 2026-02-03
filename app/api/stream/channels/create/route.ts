import { NextRequest, NextResponse } from "next/server";
import {
  createWebinarChannel,
  createClassChannel,
  createConsultationChannel,
  createSubscriptionChannel,
  createChannel,
} from "@/actions/stream/chat/channel.action";
import { getSession } from "@/lib/auth-server";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await req.json();
    const {
      channelType,
      eventId,
      eventType,
      channelName,
      members,
      createdById,
    } = body;

    // Validate required fields
    if (!channelType || !createdById) {
      return NextResponse.json(
        { success: false, error: "channelType and createdById are required" },
        { status: 400 },
      );
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (!isPrivileged && createdById !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    let result;

    if (eventType && eventId) {
      // Event-linked channel creation - use our improved functions with full participant lists
      console.log(
        `Creating ${eventType} channel for event ${eventId} by user ${createdById}`,
      );

      try {
        switch (eventType) {
          case "webinar":
            result = await createWebinarChannel(eventId);
            break;
          case "class":
            result = await createClassChannel(eventId);
            break;
          case "consultation":
            result = await createConsultationChannel(eventId);
            break;
          case "subscription":
            result = await createSubscriptionChannel(eventId);
            break;
          default:
            return NextResponse.json(
              { success: false, error: `Unknown event type: ${eventType}` },
              { status: 400 },
            );
        }

        console.log(
          `Successfully created ${eventType} channel for event ${eventId}:`,
          result,
        );
      } catch (eventError) {
        console.error(
          `Error creating ${eventType} channel for event ${eventId}:`,
          eventError,
        );
        throw eventError; // Re-throw to be caught by outer catch block
      }
    } else {
      // Custom channel creation - use basic channel creation
      if (!channelName) {
        return NextResponse.json(
          {
            success: false,
            error: "channelName is required for custom channels",
          },
          { status: 400 },
        );
      }

      const channelId = crypto.randomUUID();
      console.log(
        `Creating custom ${channelType} channel: ${channelId} with name: ${channelName}`,
      );

      result = await createChannel({
        channelType: channelType as "messaging" | "team",
        channelId,
        channelName,
        members: members || [createdById],
        createdById,
        additionalData: { custom: true },
      });
    }

    return NextResponse.json({
      success: true,
      data: result,
      message: eventType
        ? `${eventType.charAt(0).toUpperCase() + eventType.slice(1)} channel created successfully`
        : "Custom channel created successfully",
    });
  } catch (error) {
    console.error("Error creating channel via API:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create channel",
      },
      { status: 500 },
    );
  }
}
