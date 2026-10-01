/**
 * GET /api/consultant/payout-setup — the Get-paid page's refetch (#1675 PR-Y2).
 * Thin: the session, the profile, then the same lib/data read the RSC page seeds.
 */

import { NextResponse } from "next/server";
import { requireOwnConsultantProfile } from "@/lib/api/consultant-profile";
import { apiError } from "@/lib/errors/api-error";
import { readConsultantPayoutSetup } from "@/lib/data/consultant-payout-setup";

export async function GET() {
  try {
    const { profileId, error } = await requireOwnConsultantProfile();
    if (error) return error;
    const setup = await readConsultantPayoutSetup(profileId);
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
