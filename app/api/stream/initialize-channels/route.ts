import { initializeAllChannels } from "@/actions/channel.action";
import { NextResponse } from "next/server";

export async function POST() {
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
