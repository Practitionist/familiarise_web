import { NextRequest, NextResponse } from "next/server";
import { validateReferralCode } from "@/lib/referrals/service";
import prisma from "@/lib/prisma";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await params;

    if (!code) {
      return NextResponse.json(
        { error: "Code parameter is required" },
        { status: 400 },
      );
    }

    const referralCode = await validateReferralCode(code);

    if (!referralCode) {
      return NextResponse.json({
        data: { valid: false, referrerName: null },
      });
    }

    // Fetch referrer's name for the signup page banner
    const user = await prisma.user.findUnique({
      where: { id: referralCode.userId },
      select: { name: true },
    });

    return NextResponse.json({
      data: {
        valid: true,
        referrerName: user?.name ?? null,
        refereeReward: referralCode.refereeReward,
      },
    });
  } catch (error) {
    console.error("Error checking referral code:", error);
    return NextResponse.json(
      { error: "Failed to check referral code" },
      { status: 500 },
    );
  }
}
