/**
 * GET /api/consultant/payout-setup — the Get-paid page's refetch (#1675 PR-Y2).
 * Thin: the session, the profile, then the same lib/data read the RSC page seeds.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { apiError } from "@/lib/errors/api-error";
import { readConsultantPayoutSetup } from "@/lib/data/consultant-payout-setup";

export async function GET() {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }
    const setup = await readConsultantPayoutSetup(consultantProfile.id);
    // Money-setup truth is never cached (#1675).
    return NextResponse.json(setup, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError({
      tag: "[Consultant.PayoutSetup.GET]",
      error,
      fallbackMessage: "Failed to load payout setup",
    });
  }
}
