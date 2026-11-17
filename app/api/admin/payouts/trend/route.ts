/**
 * GET /api/admin/payouts/trend
 *
 * #997 secondary findings — the "Payouts - Last 7 Days" chart used to fetch
 * `/api/admin/payouts?limit=100` and bucket the raw rows into days in the
 * browser (a TODO in the client flagged `limit=100` as not 7-day-safe at
 * scale). This endpoint bounds the query to the actual 7-day window and does
 * the bucketing server-side.
 *
 * Prisma's `groupBy` can't truncate a timestamp to a calendar day (no
 * expression support without raw SQL, which this repo avoids), so we select
 * only `{createdAt, amount}` inside the window — far narrower than the old
 * ≤100-row/all-columns fetch — and bucket in JS.
 */
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { istDateKey, istDayStart } from "@/lib/compliance/ist-period";

const TREND_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "17 Nov" for an IST date key "2026-11-17". */
function dayLabel(key: string): string {
  const [, month, day] = key.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

export async function GET() {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    // The seven IST calendar days ending today; India keeps one offset, so each is 24 h.
    const since = new Date(
      istDayStart(new Date()).getTime() - (TREND_DAYS - 1) * DAY_MS,
    );

    const rows = await prisma.consultantPayout.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, amount: true },
    });

    const buckets = new Map<string, { label: string; totalPaise: number }>();
    for (let i = 0; i < TREND_DAYS; i++) {
      const key = istDateKey(new Date(since.getTime() + i * DAY_MS));
      buckets.set(key, { label: dayLabel(key), totalPaise: 0 });
    }

    for (const row of rows) {
      const bucket = buckets.get(istDateKey(row.createdAt));
      if (bucket) bucket.totalPaise += row.amount;
    }

    const series = Array.from(buckets.entries()).map(([day, v]) => ({
      day,
      label: v.label,
      totalPaise: v.totalPaise,
    }));

    return NextResponse.json({ series });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching payout trend:", error);
    return NextResponse.json(
      { error: "Failed to fetch payout trend" },
      { status: 500 },
    );
  }
}
