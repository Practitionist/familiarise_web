import { checkoutSchema } from "@/schemas/checkout";
import {
  handleDevelopmentCheckout,
  handleProductionCheckout,
} from "@/utils/payments";
import { 
  checkoutRateLimiter, 
  createRateLimitResponse 
} from "@/utils/rateLimiter";
import { 
  handleApiError, 
  generateRequestId,
  AppErrors,
  ErrorLogger 
} from "@/utils/errorHandling";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../auth/[...nextauth]/options";

export async function POST(req: NextRequest) {
  const requestId = generateRequestId();
  
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      throw AppErrors.unauthorized();
    }

    // Apply rate limiting
    const rateLimitResult = checkoutRateLimiter.checkLimit(req, session.user.id);
    if (!rateLimitResult.allowed) {
      const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      ErrorLogger.warn(
        `Rate limit exceeded for user ${session.user.id}`,
        { userId: session.user.id, ip: clientIP, retryAfter: rateLimitResult.retryAfter }
      );
      return createRateLimitResponse(rateLimitResult);
    }

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);

    ErrorLogger.info("Checkout request initiated", {
      requestId,
      userId: session.user.id,
      appointmentType: validatedData.appointmentType,
      planId: validatedData.planId,
      paymentGateway: validatedData.paymentGateway,
    });

    // Check if payment should be skipped (for development/testing)
    const skipPayment = process.env.SKIP_PAYMENT === "true";

    let result;
    if (skipPayment) {
      // DEVELOPMENT FLOW: Create appointment first, then skip payment
      ErrorLogger.info("Processing development checkout", { requestId });
      result = await handleDevelopmentCheckout(
        validatedData,
        session.user.id,
      );
    } else {
      // PRODUCTION FLOW: Create payment first, then appointment ONLY after payment succeeds
      ErrorLogger.info("Processing production checkout", { requestId });
      result = await handleProductionCheckout(
        validatedData,
        session.user.id,
      );
    }

    ErrorLogger.info("Checkout completed successfully", {
      requestId,
      success: result.success,
      skipPayment: "skipPayment" in result ? result.skipPayment : false,
    });

    return NextResponse.json(result);
  } catch (error) {
    ErrorLogger.error("Checkout failed", error, {
      requestId,
      userId: (await getServerSession(authOptions))?.user?.id,
    });

    return handleApiError(error, requestId);
  }
}
