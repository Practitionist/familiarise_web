import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DiscountType } from "@prisma/client";

interface ValidateDiscountRequest {
  code: string;
  amount?: number; // Optional: base amount to calculate discount
}

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
    const body: ValidateDiscountRequest = await request.json();
    const { code, amount } = body;

    if (!code || typeof code !== "string") {
      return NextResponse.json<DiscountCodeResponse>(
        { valid: false, message: "Discount code is required" },
        { status: 400 }
      );
    }

    const discountCode = await prisma.discountCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });

    if (!discountCode) {
      return NextResponse.json<DiscountCodeResponse>(
        { valid: false, message: "Invalid discount code" },
        { status: 404 }
      );
    }

    // Check if code is active
    if (!discountCode.isActive) {
      return NextResponse.json<DiscountCodeResponse>(
        { valid: false, message: "This discount code is no longer active" },
        { status: 400 }
      );
    }

    // Check if code has expired
    if (discountCode.expiresAt && new Date() > discountCode.expiresAt) {
      return NextResponse.json<DiscountCodeResponse>(
        { valid: false, message: "This discount code has expired" },
        { status: 400 }
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
        { status: 400 }
      );
    }

    // Calculate discount amount if base amount provided
    let discountAmount: number | undefined;
    if (amount && amount > 0) {
      if (discountCode.discountType === DiscountType.PERCENTAGE) {
        discountAmount = Math.round((amount * discountCode.discountValue) / 100);
        // Apply max discount cap if set
        if (discountCode.maxDiscount !== null && discountAmount > discountCode.maxDiscount) {
          discountAmount = discountCode.maxDiscount;
        }
      } else if (discountCode.discountType === DiscountType.FIXED_AMOUNT) {
        discountAmount = Math.min(discountCode.discountValue, amount);
      }
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
    console.error("Error validating discount code:", error);
    return NextResponse.json<DiscountCodeResponse>(
      { valid: false, message: "Failed to validate discount code" },
      { status: 500 }
    );
  }
}
