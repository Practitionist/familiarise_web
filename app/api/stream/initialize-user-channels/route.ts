import { NextRequest, NextResponse } from "next/server";
import { syncUserEventChannels } from "@/actions/event-channel.action";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "User ID is required" },
        { status: 400 },
      );
    }

    console.log(`Initializing channels for user: ${userId}`);

    // Synchronize event channels for the user
    const result = await syncUserEventChannels(userId);

    return NextResponse.json({
      success: true,
      message: "Channels initialized successfully",
      result,
    });
  } catch (error) {
    console.error("Error initializing channels:", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
