import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import {
  dropAnsweredHeldSeats,
  dropSettled,
  HELD_PAID_SEAT_PREFIX,
} from "@/lib/backoffice/needs-human";

/**
 * #1771 K-5 — credit seats the automatic paths could not settle: a series
 * cancel after delivered sessions (`partial-credit:<paymentId>`) and a skipped
 * make-up on a credit seat. The Refunds tab offers the credit door on each.
 * #1834 — plus paid seats still HELD at settle, which get the issue door.
 */
export async function GET() {
  const auth = await requireBackofficeSurface("refunds.read");
  if (auth.error) return auth.error;
  const events = await prisma.systemEvent.findMany({
    where: {
      OR: [
        { correlationId: { startsWith: "partial-credit:" } },
        { message: { contains: "CREDIT_SEAT_PARTIAL_RESTORE" } },
        { correlationId: { startsWith: HELD_PAID_SEAT_PREFIX } },
      ],
      createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      message: true,
      context: true,
      createdAt: true,
      correlationId: true,
    },
  });
  const listed = events.map((e) => {
    const ctx = (e.context ?? {}) as { paymentId?: unknown };
    const heldSeat = !!e.correlationId?.startsWith(HELD_PAID_SEAT_PREFIX);
    return {
      id: e.id,
      message: e.message,
      createdAt: e.createdAt,
      paymentId: typeof ctx.paymentId === "string" ? ctx.paymentId : null,
      kind: heldSeat ? ("held-paid-seat" as const) : ("credit" as const),
    };
  });
  const [credit, held] = await Promise.all([
    dropSettled(listed.filter((i) => i.kind === "credit")),
    dropAnsweredHeldSeats(listed.filter((i) => i.kind === "held-paid-seat")),
  ]);
  const items = [...credit, ...held].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
