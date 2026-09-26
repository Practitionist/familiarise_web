import { NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readClassSeries } from "@/lib/backoffice/class-series-read";

/** #1771 K-6 — one class's series ledger, sessions, flag and seats. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const auth = await requireBackofficeSurface("classSeries.support");
  if (auth.error) return auth.error;
  const { classId } = await params;
  const view = await readClassSeries(classId);
  if (!view) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
