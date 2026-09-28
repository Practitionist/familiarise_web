/**
 * GET /api/user/support-tickets/[ticketId] — #1527 the requester's own ticket
 * for the request page: owner-scoped in the query, private notes never read.
 */

import { NextResponse, type NextRequest } from "next/server";

import { supportError } from "@/lib/api/support-http";
import { getSession } from "@/lib/auth-server";
import { readOwnTicket } from "@/lib/support/own-case-read";

const ROUTE = "user.support-ticket";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return supportError({ status: 401, code: "UNAUTHORIZED" });
  }
  const { ticketId } = await params;
  try {
    const data = await readOwnTicket(ticketId, session.user.id);
    if (!data) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        context: { route: ROUTE, ticketId },
      });
    }
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: ROUTE, ticketId },
    });
  }
}
