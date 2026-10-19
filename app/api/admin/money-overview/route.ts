/**
 * GET /api/admin/money-overview
 *
 * The back-office "money in flight" dashboard's wire contract. One read
 * model (`lib/backoffice/money-overview.ts`) backs both this route and the
 * page, so the numbers on screen and the numbers on the wire are the same
 * numbers.
 *
 * `?days=7|30|90` picks the window; `?drill=<key>` appends the rows behind
 * one number (and `?reason=` narrows the refund-reason drill to one code).
 *
 * Read-only, and guarded on `payments.read` — the surface the Money group's
 * own sections are gated on.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import {
  isMoneyDrillKey,
  readMoneyDrill,
  readMoneyOverview,
} from "@/lib/backoffice/money-overview";
import {
  DEFAULT_MONEY_OVERVIEW_DAYS,
  isMoneyOverviewDays,
  type MoneyOverviewDays,
} from "@/schemas/money-overview";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payments.read");
    if (auth.error) return auth.error;

    const params = req.nextUrl.searchParams;
    const daysParam = params.get("days");
    const requested = daysParam === null ? null : Number(daysParam);
    const days: MoneyOverviewDays =
      requested !== null && isMoneyOverviewDays(requested)
        ? requested
        : DEFAULT_MONEY_OVERVIEW_DAYS;

    const drillParam = params.get("drill");
    const drillKey =
      drillParam !== null && isMoneyDrillKey(drillParam) ? drillParam : null;

    const [overview, drill] = await Promise.all([
      readMoneyOverview({ days }),
      drillKey
        ? readMoneyDrill({
            key: drillKey,
            days,
            reason: params.get("reason"),
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({ overview, drill }, { headers: NO_STORE });
  } catch (error) {
    console.error("Admin money overview error:", error);
    return NextResponse.json(
      { error: "Failed to load the money overview" },
      { status: 500 },
    );
  }
}
