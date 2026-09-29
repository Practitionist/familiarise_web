/**
 * GET /api/staff/support-inbox/stats — #1527 the inbox's team stats: open
 * cases, SLA breaches, and the 7-day average first-response time, all derived
 * from stored clocks (lib/support/case-read.ts).
 */

import { NextResponse } from "next/server";

import { supportError } from "@/lib/api/support-http";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readInboxStats } from "@/lib/support/case-read";

export async function GET() {
  const auth = await requireBackofficeSurface("tickets.manage");
  if (auth.error) return auth.error;
  try {
    return NextResponse.json(await readInboxStats(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "staff.support-inbox", action: "stats" },
    });
  }
}
