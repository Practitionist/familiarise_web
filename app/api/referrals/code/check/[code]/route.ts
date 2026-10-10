import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { validateReferralCode } from "@/lib/referrals/service";
import prisma from "@/lib/prisma";
import {
  readReferralProgramConfig,
  referralTerms,
} from "@/lib/referrals/program-config";
import {
  applyRateLimit,
  getClientIp,
  referralCheckLimiter,
} from "@/lib/rate-limit";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    // Keyed on Netlify's client IP: the first x-forwarded-for hop is client-set.
    const limited = await applyRateLimit(
      referralCheckLimiter,
      getClientIp(req),
      "referral-check",
    );
    if (limited) return limited;

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

    // First name only: codes are guessable, so the banner must not leak a full name.
    const user = await prisma.user.findUnique({
      where: { id: referralCode.userId },
      select: { name: true },
    });
    const firstName = user?.name.trim().split(/\s+/)[0] || null;

    return NextResponse.json({
      data: {
        valid: true,
        referrerName: firstName,
        terms: referralTerms(await readReferralProgramConfig()),
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error checking referral code:", error);
    return NextResponse.json(
      { error: "Failed to check referral code" },
      { status: 500 },
    );
  }
}
