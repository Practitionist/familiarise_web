import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { dropSettled } from "@/lib/backoffice/needs-human";

/**
 * #1771 K-5 — credit seats the automatic paths could not settle: a series
 * cancel after delivered sessions (`partial-credit:<paymentId>`) and a skipped
 * make-up on a credit seat. The Refunds tab offers the credit door on each.
 */
export async function GET() {
  const auth = await requireBackofficeSurface("refunds.read");
  if (auth.error) return auth.error;
  const events = await prisma.systemEvent.findMany({
    where: {
      OR: [
        { correlationId: { startsWith: "partial-credit:" } },
        { message: { contains: "CREDIT_SEAT_PARTIAL_RESTORE" } },
      ],
      createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, message: true, context: true, createdAt: true },
  });
  const listed = events.map((e) => {
    const ctx = (e.context ?? {}) as { paymentId?: unknown };
    return {
      id: e.id,
      message: e.message,
      createdAt: e.createdAt,
      paymentId: typeof ctx.paymentId === "string" ? ctx.paymentId : null,
    };
  });
  const items = await dropSettled(listed);
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
