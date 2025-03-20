import { NextRequest, NextResponse } from "next/server";
import { initializeAllChannels } from "@/actions/channel.action";

export async function POST(req: NextRequest) {
  try {
    const result = await initializeAllChannels();
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("Error initializing channels:", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
