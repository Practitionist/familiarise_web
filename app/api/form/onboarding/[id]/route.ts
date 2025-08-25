import { NextRequest, NextResponse } from "next/server";
import { updateOnboardingInformationAction } from "@/actions/forms/onboarding.action";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    console.log(
      "API Route: Received request to update onboarding information",
    );
    const { id } = await params;
    const body = await req.json();
    console.log("Request Body:", JSON.stringify(body, null, 2));

    // Use the server action for consistency
    const result = await updateOnboardingInformationAction(id, body);
    
    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      );
    }

    return NextResponse.json({
      message: "Onboarding information updated successfully",
      user: result.user,
    });
  } catch (error: unknown) {
    console.error("Error updating onboarding information:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while updating onboarding information",
      },
      { status: 500 },
    );
  }
}