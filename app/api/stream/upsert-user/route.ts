import { NextRequest, NextResponse } from "next/server";
import { upsertUserToStream } from "@/actions/user.action";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId } = body;
    
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "User ID is required" },
        { status: 400 }
      );
    }
    
    console.log(`Upserting user to Stream Chat: ${userId}`);
    
    // Upsert the user to Stream Chat
    const result = await upsertUserToStream(userId);
    
    console.log(`Successfully upserted user to Stream Chat: ${userId}`);
    
    return NextResponse.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Error upserting user to Stream Chat:", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
