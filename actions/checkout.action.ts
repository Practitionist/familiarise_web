"use server";

import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { checkoutSchema, CheckoutInput } from "@/schemas/checkout";
import {
  handleDevelopmentCheckout,
  handleProductionCheckout,
} from "@/utils/payments";

// Schema and types are now imported from utils/payments.ts

export async function checkoutAction(data: CheckoutInput) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return { error: "Unauthorized" };
    }

    // Validate input
    const validatedData = checkoutSchema.parse(data);

    // Check if payment should be skipped
    const skipPayment = process.env.SKIP_PAYMENT === "true";

    if (skipPayment) {
      // DEVELOPMENT FLOW: Create appointment first, then skip payment
      return await handleDevelopmentCheckout(validatedData, session.user.id);
    } else {
      // PRODUCTION FLOW: Create payment first, then appointment
      return await handleProductionCheckout(validatedData, session.user.id);
    }
  } catch (error) {
    console.error("Checkout error:", error);
    return {
      error: error instanceof Error ? error.message : "Checkout failed",
    };
  }
}
