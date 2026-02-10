"use server";

import { handleCheckout } from "@/lib/payments/operations/checkout";
import { CheckoutInput, checkoutSchema } from "@/schemas/checkout";
import {
  classifyError,
  logClassifiedError,
} from "@/lib/payments/error-classification";
import { getSession } from "@/lib/auth-server";

export async function checkoutAction(
  data: CheckoutInput,
  isMockPayment: boolean = false,
) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return { error: "Unauthorized" };
    }

    // Validate input
    const validatedData = checkoutSchema.parse(data);

    // Unified checkout flow: Create payment first, then appointment via webhook
    // Supports both real and mock payments via isMockPayment flag
    return await handleCheckout(validatedData, session.user.id, isMockPayment);
  } catch (error) {
    const classified = classifyError(error, "Checkout failed");
    logClassifiedError("Checkout Action", classified, error);

    return { error: classified.errorMessage };
  }
}
