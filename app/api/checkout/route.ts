import { checkoutSchema } from "@/schemas/checkout";
import { handleCheckout } from "@/lib/payments/operations/checkout";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);
    const isMockPayment = body.isMockPayment === true;

    // Unified checkout flow: Create payment first, then appointment via webhook
    // Supports both real and mock payments via isMockPayment flag
    const result = await handleCheckout(
      validatedData,
      session.user.id,
      isMockPayment,
    );
    return NextResponse.json(result);
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
      // Duplicate registration errors (webinars: "already registered", classes: "already enrolled")
      else if (
        error.message.includes("already registered") ||
        error.message.includes("already enrolled")
      ) {
        errorMessage = error.message;
        errorType = "DUPLICATE_REGISTRATION_ERROR";
      }
      // Slot availability errors (including lock acquisition failures)
      else if (
        error.message.includes("slot") ||
        error.message.includes("availability") ||
        error.message.includes("currently booking") ||
        error.message.includes("currently checking out")
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
