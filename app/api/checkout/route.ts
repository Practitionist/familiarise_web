import {
  checkoutSchema
} from "@/schemas/checkout";
import {
  handleDevelopmentCheckout,
  handleProductionCheckout,
} from "@/utils/payments";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../auth/[...nextauth]/options";

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);

    // Check if payment should be skipped (for development/testing)
    const skipPayment = process.env.SKIP_PAYMENT === "true";

    if (skipPayment) {
      // DEVELOPMENT FLOW: Create appointment first, then skip payment
      const result = await handleDevelopmentCheckout(validatedData, session.user.id);
      return NextResponse.json(result);
    } else {
      // PRODUCTION FLOW: Create payment first, then appointment ONLY after payment succeeds
      const result = await handleProductionCheckout(validatedData, session.user.id);
      return NextResponse.json(result);
    }
  } catch (error) {
    console.error("Checkout error:", error);

    // Provide specific error messages for different types of failures
    let errorMessage = "Checkout failed";
    let errorType = "UNKNOWN_ERROR";

    if (error instanceof Error) {
      // Payment gateway authentication errors
      if (
        error.message.includes("Authentication failed") ||
        error.message.includes("Invalid API key")
      ) {
        errorMessage =
          "Payment gateway configuration error. Please contact support.";
        errorType = "PAYMENT_CONFIG_ERROR";
      }
      // Prisma/Database errors
      else if (
        error.message.includes("Prisma") ||
        error.message.includes("database")
      ) {
        errorMessage = "Database error. Please try again or contact support.";
        errorType = "DATABASE_ERROR";
      }
      // Validation errors
      else if (error.message.includes("not found")) {
        errorMessage = error.message;
        errorType = "NOT_FOUND_ERROR";
      }
      // Slot availability errors
      else if (
        error.message.includes("slot") ||
        error.message.includes("availability")
      ) {
        errorMessage = error.message;
        errorType = "AVAILABILITY_ERROR";
      }
      // Payment intent creation errors
      else if (error.message.includes("Failed to create payment intent")) {
        errorMessage =
          "Payment processing unavailable. Please try again later or contact support.";
        errorType = "PAYMENT_PROCESSING_ERROR";
      } else {
        errorMessage = error.message;
      }
    }

    return NextResponse.json(
      {
        error: errorMessage,
        errorType,
        timestamp: new Date().toISOString(),
      },
      { status: 400 },
    );
  }
}
