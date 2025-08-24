import { NextRequest, NextResponse } from "next/server";
import {
  validateOnboardingData,
  updateUserProfileAndGetFkData,
  type OnboardingData,
} from "@/utils/onboarding";
import prisma from "@/lib/prisma";

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

    // Validate using shared utilities
    const validationResult = validateOnboardingData(body);
    if (!validationResult.success) {
      console.error("Validation Error:", validationResult.error);
      return NextResponse.json(
        { error: validationResult.error },
        { status: 400 }
      );
    }

    const validatedBody = validationResult.data as OnboardingData;
    
    // Check if user exists first
    const existingUser = await prisma.user.findUnique({
      where: { id },
    });
    
    if (!existingUser) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const updatedUser = await prisma.$transaction(async (tx) => {
      return await updateUserProfileAndGetFkData(
        id,
        validatedBody,
        tx,
      );
    });

    return NextResponse.json({
      message: "Onboarding information updated successfully",
      user: updatedUser,
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

