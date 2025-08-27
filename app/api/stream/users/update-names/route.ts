import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { updateStreamUserNames } from "@/actions/stream/chat/user.action";

export async function POST(req: NextRequest) {
  try {
    // Authentication check - only allow admins to run this update
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401 },
      );
    }

    // For security, you might want to add additional admin role checks here
    // For now, allowing any authenticated user in development
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { success: false, error: "This endpoint is disabled in production for security" },
        { status: 403 },
      );
    }

    console.log(`Stream Chat user names update requested by user: ${session.user.id}`);

    // Run the update function
    const result = await updateStreamUserNames();

    return NextResponse.json({
      success: true,
      message: "Stream Chat user names updated successfully",
      data: result,
    });
  } catch (error) {
    console.error("Error updating Stream Chat user names via API:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update user names",
      },
      { status: 500 },
    );
  }
}