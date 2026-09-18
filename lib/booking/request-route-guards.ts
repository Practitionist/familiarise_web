import { NextResponse } from "next/server";
import type { AppointmentStatus } from "@prisma/client";

import {
  APPROVAL_STATUSES_DETAIL_ONLY,
  USE_DETAIL_APPROVAL_MESSAGE,
  parseRequestListQuery,
  type RequestListQuery,
} from "./list-query";

/**
 * The response halves of the #1704 guards, shared by the consultation and
 * subscription request routes so each rule has one body. Server-only:
 * lib/booking/list-query.ts stays importable from the client tab.
 */

export function parseRequestListQueryOrRespond(
  searchParams: URLSearchParams,
):
  | { query: RequestListQuery; response: null }
  | { query: null; response: NextResponse } {
  const parsed = parseRequestListQuery(searchParams);
  if (!parsed.ok) {
    return {
      query: null,
      response: NextResponse.json(
        { error: parsed.error, code: parsed.code },
        { status: 400 },
      ),
    };
  }
  return { query: parsed.query, response: null };
}

/** 409 USE_DETAIL_APPROVAL for a status only the `[id]` PATCH may write. */
export function refuseApprovalOnListRoute(
  status: AppointmentStatus,
): NextResponse | null {
  if (!APPROVAL_STATUSES_DETAIL_ONLY.has(status)) return null;
  return NextResponse.json(
    { error: USE_DETAIL_APPROVAL_MESSAGE, code: "USE_DETAIL_APPROVAL" },
    { status: 409 },
  );
}

/**
 * 403 PLAN_NOT_OWNED unless the plan a PUT names belongs to the request's
 * own consultant. `readPlanOwner` is the model-specific lookup.
 */
export async function refusePlanNotOwned(
  planId: string | undefined,
  requestConsultantProfileId: string | null | undefined,
  readPlanOwner: () => Promise<{ consultantProfileId: string } | null>,
): Promise<NextResponse | null> {
  if (!planId) return null;
  const targetPlan = await readPlanOwner();
  if (
    targetPlan &&
    targetPlan.consultantProfileId === requestConsultantProfileId
  ) {
    return null;
  }
  return NextResponse.json(
    {
      error: "The plan belongs to a different consultant",
      code: "PLAN_NOT_OWNED",
    },
    { status: 403 },
  );
}
