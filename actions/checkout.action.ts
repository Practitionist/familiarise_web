"use server";

import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { checkoutSchema, CheckoutInput } from "@/schemas/checkout";
import {
  handleDevelopmentCheckout,
  handleProductionCheckout,
} from "@/lib/payments/operations/checkout";

export async function checkoutAction(
  data: CheckoutInput,
  isMockPayment: boolean = false,
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return { error: "Unauthorized" };
    }

    // Validate input
    const validatedData = checkoutSchema.parse(data);

    // Check if payment should be skipped (legacy dev mode)
    const skipPayment = process.env.SKIP_PAYMENT === "true";

    if (skipPayment) {
      // LEGACY DEVELOPMENT FLOW: Create appointment first, skip payment entirely
      // @deprecated Use mock payments instead
      return await handleDevelopmentCheckout(validatedData, session.user.id);
    } else {
      // PRODUCTION FLOW: Create payment first, then appointment via webhook
      // Supports both real and mock payments
      return await handleProductionCheckout(
        validatedData,
        session.user.id,
        isMockPayment,
      );
    }
  } catch (error) {
    console.error("Checkout error:", error);
    return {
      error: error instanceof Error ? error.message : "Checkout failed",
    };
  }
}
