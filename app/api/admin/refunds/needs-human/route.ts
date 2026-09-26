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
type EventRow = {
  id: string;
  message: string;
  context: unknown;
  createdAt: Date;
};

const EVENT_SELECT = {
  id: true,
  message: true,
  context: true,
  createdAt: true,
} as const;

function contextString(ctx: unknown, key: string): string | null {
  const v = (ctx as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : null;
}

function toItem(e: EventRow, kind: "credit" | "held-paid-seat") {
  const unit = (e.context as { unitPaise?: unknown } | null)?.unitPaise;
  return {
    id: e.id,
    message: e.message,
    createdAt: e.createdAt,
    paymentId: contextString(e.context, "paymentId"),
    occurrenceId: contextString(e.context, "occurrenceId"),
    unitPaise: typeof unit === "number" ? unit : null,
    kind,
  };
}

export async function GET() {
  const auth = await requireBackofficeSurface("refunds.read");
  if (auth.error) return auth.error;
  // Sequential reads: one pooled connection (PG_POOL_MAX=1) serialises them anyway.
  const creditEvents = await prisma.systemEvent.findMany({
    where: {
      OR: [
        { correlationId: { startsWith: "partial-credit:" } },
        { message: { contains: "CREDIT_SEAT_PARTIAL_RESTORE" } },
      ],
      createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: EVENT_SELECT,
  });
  // #1834 — a held paid seat is a rare anomaly that stays listed until its own
  // refund lands, so this read has no age window and no shared cap.
  const heldEvents = await prisma.systemEvent.findMany({
    where: { correlationId: { startsWith: HELD_PAID_SEAT_PREFIX } },
    orderBy: { createdAt: "desc" },
    select: EVENT_SELECT,
  });
  const credit = await dropSettled(
    creditEvents.map((e) => toItem(e, "credit")),
  );
  const held = await dropAnsweredHeldSeats(
    heldEvents.map((e) => toItem(e, "held-paid-seat")),
  );
  const items = [...credit, ...held].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
