import { NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readRefundNeedsHuman } from "@/lib/backoffice/needs-human";

/**
 * #1771 K-5 — credit seats the automatic paths could not settle: a series
 * cancel after delivered sessions (`partial-credit:<paymentId>`) and a skipped
 * make-up on a credit seat. The Refunds tab offers the credit door on each.
 * #1834 — plus paid seats still HELD at settle, which get the issue door.
 */
export async function GET() {
  const auth = await requireBackofficeSurface("refunds.read");
  if (auth.error) return auth.error;
  const items = await readRefundNeedsHuman();
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
