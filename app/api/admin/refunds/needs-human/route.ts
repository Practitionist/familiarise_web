import { NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readRefundNeedsHuman } from "@/lib/backoffice/needs-human";
import { resolveTargets, targetKey } from "@/lib/backoffice/target-refs";

/**
 * #1771 K-5 — credit seats the automatic paths could not settle: a series
 * cancel after delivered sessions (`partial-credit:<paymentId>`) and a skipped
 * make-up on a credit seat. The Refunds tab offers the credit door on each.
 * #1834 — plus paid seats still HELD at settle, which get the issue door, and
 * refunds another door's owed refund held, which get it with their amount.
 */
export async function GET() {
  const auth = await requireBackofficeSurface("refunds.read");
  if (auth.error) return auth.error;
  const rows = await readRefundNeedsHuman();
  // Each item names who paid and for which booking, in one batched read.
  const targets = await resolveTargets(
    rows.flatMap((r) =>
      r.paymentId ? [{ kind: "Payment", id: r.paymentId }] : [],
    ),
  );
  const items = rows.map((r) => ({
    ...r,
    target: r.paymentId
      ? (targets.get(targetKey("Payment", r.paymentId)) ?? null)
      : null,
  }));
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
