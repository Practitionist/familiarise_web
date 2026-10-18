import { NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readExpertStrikeReview } from "@/lib/booking/expert-reliability";

/** D10 — experts with reliability strikes in the last 90 days, most first. */
export async function GET() {
  const auth = await requireBackofficeSurface("classSeries.support");
  if (auth.error) return auth.error;
  const items = await readExpertStrikeReview();
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
