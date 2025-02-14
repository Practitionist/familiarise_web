import { StreamClient } from "@stream-io/node-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId } = await req.json();
    if (!userId) {
      return NextResponse.json(
        { error: "User ID is required" },
        { status: 400 },
      );
    }

    const api_key = process.env.NEXT_PUBLIC_STREAM_API_KEY;
    const api_secret = process.env.STREAM_API_SECRET;

    if (!api_key || !api_secret) {
      return NextResponse.json(
        { error: "Stream credentials not configured" },
        { status: 500 },
      );
    }

    // Create Stream client
    const streamClient = new StreamClient(api_key, api_secret);

    // Generate token with expiration
    const expirationTime = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour
    const issuedAt = Math.floor(Date.now() / 1000) - 60; // 1 minute ago

    const token = streamClient.createToken(userId, expirationTime, issuedAt);

    return NextResponse.json({ token });
  } catch (error) {
    console.error("Error generating Stream token:", error);
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 },
    );
  }
}
