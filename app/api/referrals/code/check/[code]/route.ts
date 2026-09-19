import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { validateReferralCode } from "@/lib/referrals/service";
import prisma from "@/lib/prisma";
import { Ratelimit } from "@upstash/ratelimit";
import redis from "@/lib/redis";

// Rate limit: 10 requests per minute per IP to prevent brute-force enumeration
const ratelimit = new Ratelimit({
  redis: redis as ConstructorParameters<typeof Ratelimit>[0]["redis"],
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit:referral-check",
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    // Rate limit by IP
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const { success, remaining } = await ratelimit.limit(ip);

    if (!success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "X-RateLimit-Remaining": String(remaining),
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const { code } = await params;

    if (!code) {
      return NextResponse.json(
        { error: "Code parameter is required" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const referralCode = await validateReferralCode(code);

    if (!referralCode) {
      return NextResponse.json(
        {
          data: { valid: false, referrerName: null },
        },
        {
          // Brute-forceable lookup that names a user: rate-limited and never
          // shared-cached.
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    // Fetch referrer's name for the signup page banner
    const user = await prisma.user.findUnique({
      where: { id: referralCode.userId },
      select: { name: true },
    });

    return NextResponse.json(
      {
        data: {
          valid: true,
          referrerName: user?.name ?? null,
          refereeReward: referralCode.refereeReward,
          // FIX #437: Credits are now given after first booking, not on signup
          rewardTiming: "after_first_booking",
        },
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error checking referral code:", error);
    return NextResponse.json(
      { error: "Failed to check referral code" },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
