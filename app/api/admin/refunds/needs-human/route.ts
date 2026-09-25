import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

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

/**
 * A seat leaves the queue once a credit return landed after its event, or once
 * no credit is still consumed — so a second admin is never offered it again.
 */
async function dropSettled<
  T extends { createdAt: Date; paymentId: string | null },
>(items: T[]): Promise<T[]> {
  const ids = [
    ...new Set(items.flatMap((i) => (i.paymentId ? [i.paymentId] : []))),
  ];
  if (ids.length === 0) return items;
  const [returns, usages] = await Promise.all([
    prisma.refund.findMany({
      where: { paymentId: { in: ids }, status: "SUCCEEDED" },
      select: { paymentId: true, createdAt: true },
    }),
    prisma.referralCreditUsage.findMany({
      where: { paymentId: { in: ids } },
      select: { paymentId: true, amount: true },
    }),
  ]);
  const stillUsed = new Map<string, number>();
  for (const u of usages) {
    stillUsed.set(
      u.paymentId,
      (stillUsed.get(u.paymentId) ?? 0) + Number(u.amount),
    );
  }
  return items.filter((item) => {
    if (!item.paymentId) return true;
    const returnedSince = returns.some(
      (r) => r.paymentId === item.paymentId && r.createdAt > item.createdAt,
    );
    return !returnedSince && (stillUsed.get(item.paymentId) ?? 0) > 0;
  });
}
