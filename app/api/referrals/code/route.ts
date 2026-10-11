import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { getReferralCode, createReferralCode } from "@/lib/referrals/service";
import {
  readReferralProgramConfig,
  referralTerms,
} from "@/lib/referrals/program-config";

function currentCapWeekKey(now: Date = new Date()): string {
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

async function readActiveFeeWaivers(userId: string) {
  const profile = await prisma.consultantProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!profile) return [];
  const rows = await prisma.consultantFeeWaiver.findMany({
    where: {
      consultantProfileId: profile.id,
      sessionsRemaining: { gt: 0 },
      expiresAt: { gt: new Date() },
    },
    orderBy: { expiresAt: "asc" },
  });
  return rows.map((w) => ({
    id: w.id,
    reason: w.reason,
    sessionsRemaining: w.sessionsRemaining,
    expiresAt: w.expiresAt.toISOString(),
  }));
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [code, cfg] = await Promise.all([
      getReferralCode(session.user.id),
      readReferralProgramConfig(),
    ]);
    const weeklyVestCap = cfg?.weeklyVestCap ?? 3;
    const feeWaivers = await readActiveFeeWaivers(session.user.id);
    const terms = referralTerms(cfg);
    const effectiveWeekVests =
      code?.capWeek === currentCapWeekKey() ? code.weekVests : 0;
    return NextResponse.json({
      data: code
        ? { ...code, weekVests: effectiveWeekVests, weeklyVestCap }
        : null,
      terms,
      feeWaivers,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error fetching referral code:", error);
    return NextResponse.json(
      { error: "Failed to fetch referral code" },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [code, cfg] = await Promise.all([
      createReferralCode(session.user.id),
      readReferralProgramConfig(),
    ]);
    const weeklyVestCap = cfg?.weeklyVestCap ?? 3;
    const feeWaivers = await readActiveFeeWaivers(session.user.id);
    const terms = referralTerms(cfg);
    const effectiveWeekVests =
      code.capWeek === currentCapWeekKey() ? code.weekVests : 0;
    return NextResponse.json({
      data: { ...code, weekVests: effectiveWeekVests, weeklyVestCap },
      terms,
      feeWaivers,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error creating referral code:", error);
    return NextResponse.json(
      { error: "Failed to create referral code" },
      { status: 500 },
    );
  }
}
