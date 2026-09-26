/**
 * GET /api/consultant/offering-stats — per-offering Bookings and Earnings for
 * the owner's Offerings cards and the Earnings "By offering" table (#1527,
 * #1827). Session-derived: a consultant only ever reads their own plans.
 */

import { NextResponse } from "next/server";
import { requireOwnConsultantProfile } from "@/lib/api/consultant-profile";
import { apiError } from "@/lib/errors/api-error";
import { readOfferingStats } from "@/lib/data/offering-stats";

export async function GET() {
  try {
    const { profileId, error } = await requireOwnConsultantProfile();
    if (error) return error;
    const data = await readOfferingStats(profileId);
    // Money figures for one person: never shared, never stored.
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError({
      tag: "[Consultant.OfferingStats.GET]",
      error,
      fallbackMessage: "Failed to load offering stats",
    });
  }
}
