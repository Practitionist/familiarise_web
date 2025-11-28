"use server";

import authOptions from "@/app/api/auth/[...nextauth]/options";
import { handleCheckout } from "@/lib/payments/operations/checkout";
import { CheckoutInput, checkoutSchema } from "@/schemas/checkout";
import { getServerSession } from "next-auth";

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

    // Unified checkout flow: Create payment first, then appointment via webhook
    // Supports both real and mock payments via isMockPayment flag
    return await handleCheckout(validatedData, session.user.id, isMockPayment);
  } catch (error) {
    console.error("Checkout error:", error);
    return {
      error: error instanceof Error ? error.message : "Checkout failed",
    };
  }
}
