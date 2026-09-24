import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { DiscountType } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { discountLimiter, applyRateLimit } from "@/lib/rate-limit";
import { computeDiscountPaise } from "@/lib/payments/pricing/derive-checkout-amount";
import { validateDiscountCurrency } from "@/lib/payments/validation/currency-guards";

// CodeRabbit on #1753 — the preview shares checkout's arithmetic, so it also
// refuses the inputs checkout would: a non-integer or negative amount, a
// non-string currency. Zero is allowed (a free plan previews a zero discount).
const validateDiscountRequestSchema = z.object({
  code: z.string().min(1, "Discount code is required"),
  amount: z.number().int().nonnegative().safe().optional(),
  currency: z.string().trim().toUpperCase().optional().default("INR"),
});

interface DiscountCodeResponse {
  valid: boolean;
  code?: string;
  discountType?: DiscountType;
  discountValue?: number;
  discountAmount?: number; // Calculated discount amount
  maxDiscount?: number | null;
  message?: string;
}

/**
 * POST /api/discount-codes/validate
 * Validates a discount code and returns discount details
 */
export async function POST(request: NextRequest) {
  try {
    // Authentication check
    const session = await getSession(true);
    if (!session?.user) {
      return NextResponse.json(
        { valid: false, message: "Unauthorized" },
        { status: 401 },
      );
    }

    // Rate limit: 10 discount validations per minute per user
    const rl = await applyRateLimit(discountLimiter, session.user.id);
    if (rl) return rl;

    const parsed = validateDiscountRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json<DiscountCodeResponse>(
        {
          valid: false,
          message:
            parsed.error.issues[0]?.message ?? "Invalid discount request",
        },
        { status: 400 },
      );
    }
    const { code, amount, currency: planCurrency } = parsed.data;

    const discountCode = await prisma.discountCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });

    if (!discountCode) {
      return NextResponse.json<DiscountCodeResponse>(
        { valid: false, message: "Invalid discount code" },
        { status: 404 },
      );
    }

    // Check if code is active
    if (!discountCode.isActive) {
      return NextResponse.json<DiscountCodeResponse>(
        { valid: false, message: "This discount code is no longer active" },
        { status: 400 },
      );
    }

    // Check if code has expired
    if (discountCode.expiresAt && new Date() > discountCode.expiresAt) {
      return NextResponse.json<DiscountCodeResponse>(
        { valid: false, message: "This discount code has expired" },
        { status: 400 },
      );
    }

    // Check if max uses reached
    if (
      discountCode.maxUses !== null &&
      discountCode.currentUses >= discountCode.maxUses
    ) {
      return NextResponse.json<DiscountCodeResponse>(
        {
          valid: false,
          message: "This discount code has reached its maximum uses",
        },
        { status: 400 },
      );
    }

    // Sanity-check stored discount value (guards against bad data created directly in DB)
    if (
      discountCode.discountType === DiscountType.PERCENTAGE &&
      (discountCode.discountValue < 1 || discountCode.discountValue > 100)
    ) {
      return NextResponse.json<DiscountCodeResponse>(
        {
          valid: false,
          message: "This discount code has an invalid configuration",
        },
        { status: 400 },
      );
    }

    // #1584 P1-FX04c — the same guard checkout applies: a FIXED_AMOUNT code in
    // another currency previews as invalid here instead of failing at charge.
    if (
      !validateDiscountCurrency(
        {
          discountType: discountCode.discountType,
          currency: discountCode.currency,
        },
        planCurrency,
      )
    ) {
      return NextResponse.json<DiscountCodeResponse>(
        {
          valid: false,
          message: "This discount code is for a different currency",
        },
        { status: 400 },
      );
    }

    // #1584 P1-FX04c — one discount arithmetic, shared with checkout.
    let discountAmount: number | undefined;
    if (amount && amount > 0) {
      discountAmount = computeDiscountPaise(amount, {
        discountType: discountCode.discountType,
        discountValue: discountCode.discountValue,
        maxDiscount: discountCode.maxDiscount,
      });
    }

    return NextResponse.json<DiscountCodeResponse>({
      valid: true,
      code: discountCode.code,
      discountType: discountCode.discountType,
      discountValue: discountCode.discountValue,
      discountAmount,
      maxDiscount: discountCode.maxDiscount,
      message: "Discount code applied successfully",
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "payments" } },
    );
    console.error("Error validating discount code:", error);
    return NextResponse.json<DiscountCodeResponse>(
      { valid: false, message: "Failed to validate discount code" },
      { status: 500 },
    );
  }
}
