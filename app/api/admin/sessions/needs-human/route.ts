import { NextRequest, NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { needsHumanQuerySchema } from "@/lib/backoffice/needs-human-queue";
import { readSessionsNeedingHuman } from "@/lib/backoffice/session-outcomes";

/** One page of the sessions the outcome sweep parked for a human decision. */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("classSeries.support");
  if (auth.error) return auth.error;
  const parsed = needsHumanQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid page or sort" },
      { status: 400 },
    );
  }
  const page = await readSessionsNeedingHuman(parsed.data);
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}
