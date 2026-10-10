/**
 * GET /api/staff/support-inbox — #1527 the back-office Support inbox: tickets
 * and not-yet-escalated conversations as one list of cases, server-paginated
 * (lib/support/inbox-query.ts; the nav badge counts the same builders).
 */

import { NextResponse, type NextRequest } from "next/server";

import { supportError } from "@/lib/api/support-http";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readInboxPage } from "@/lib/support/case-read";
import { parseInboxFilters } from "@/lib/support/inbox-query";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("tickets.manage");
  if (auth.error) return auth.error;
  try {
    const params = new URL(req.url).searchParams;
    const filters = parseInboxFilters(
      (key) => params.get(key),
      auth.session.user.id,
    );
    const page = Number.parseInt(params.get("page") ?? "1", 10);
    const data = await readInboxPage(filters, Number.isFinite(page) ? page : 1);
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "staff.support-inbox", action: "list" },
    });
  }
}
