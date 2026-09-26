import { NextRequest, NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { listClassesForPicker } from "@/lib/backoffice/class-series-read";

/** #1771 K-6 — the Class-series tab's picker: recent classes, by title or id. */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("classSeries.support");
  if (auth.error) return auth.error;
  const classes = await listClassesForPicker(
    req.nextUrl.searchParams.get("q") ?? "",
  );
  return NextResponse.json(
    { classes },
    { headers: { "Cache-Control": "no-store" } },
  );
}
