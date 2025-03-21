import { NextRequest, NextResponse } from "next/server";
import { StreamChat } from "stream-chat";
import { upsertUserToStream } from "@/actions/user.action";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_SECRET_KEY;

export async function POST(req: NextRequest) {
  try {
    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { success: false, error: "Stream API keys not configured" },
        { status: 500 },
      );
    }

    const body = await req.json();
    const { channelId, userId } = body;

    if (!channelId || !userId) {
      return NextResponse.json(
        { success: false, error: "Channel ID and User ID are required" },
        { status: 400 },
      );
    }

    // Initialize the Stream Chat client with server-side credentials
    const client = StreamChat.getInstance(apiKey, apiSecret);

    // First, ensure the user is registered with Stream Chat
    await upsertUserToStream(userId);

    // Get the channel
    const channel = client.channel("team", channelId);

    // Add the user to the channel
    await channel.addMembers([userId]);

    return NextResponse.json(
      { success: true, message: "User added to channel successfully" },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error adding user to channel:", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
