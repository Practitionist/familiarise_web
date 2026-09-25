import { NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readSessionsNeedingHuman } from "@/lib/backoffice/session-outcomes";

/** #1569 A-10 — sessions the outcome sweep parked for a human decision. */
export async function GET() {
  const auth = await requireBackofficeSurface("classSeries.support");
  if (auth.error) return auth.error;
  const items = await readSessionsNeedingHuman();
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
