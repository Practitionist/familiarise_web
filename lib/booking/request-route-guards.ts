import { NextResponse } from "next/server";
import type { AppointmentStatus } from "@prisma/client";

import {
  EVENT_ID_INVALID_MESSAGE,
  isEventIdFormat,
} from "@/schemas/slotAllocation/validationSchemas";
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

/**
 * 400 VALIDATION_ERROR for a path id that is not a UUID/CUID, so no read
 * (including the authz lookup) ever runs on an arbitrary string.
 */
export function refuseMalformedEventId(id: string): NextResponse | null {
  if (isEventIdFormat(id)) return null;
  return NextResponse.json(
    { error: EVENT_ID_INVALID_MESSAGE, code: "VALIDATION_ERROR" },
    { status: 400 },
  );
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

/** What the two PUT routes read off the plan a `planId` names. */
export interface PlanOwnership {
  consultantProfileId: string;
  organizationId: string | null;
}

/**
 * 403 PLAN_NOT_OWNED unless the plan a PUT names belongs to the request's
 * own consultant, then 403 PLAN_ORG_MISMATCH unless it also sits in the
 * booking's funding org (`bookingOrgId`, plan first then appointment; null
 * is personal, so personal only swaps for personal). `readPlanOwner` is the
 * model-specific lookup.
 */
export async function refusePlanNotOwned(
  planId: string | undefined,
  request: {
    consultantProfileId: string | null | undefined;
    /** `bookingOrgId(existing)` — the org that funds this booking. */
    organizationId: string | null;
  },
  readPlanOwner: () => Promise<PlanOwnership | null>,
): Promise<NextResponse | null> {
  if (!planId) return null;
  const targetPlan = await readPlanOwner();
  if (
    !targetPlan ||
    targetPlan.consultantProfileId !== request.consultantProfileId
  ) {
    return NextResponse.json(
      {
        error: "The plan belongs to a different consultant",
        code: "PLAN_NOT_OWNED",
      },
      { status: 403 },
    );
  }
  // A plan swap that changes the funding org would re-rail the booking's
  // money (#1717 triage #14); the org is fixed at request time.
  if (targetPlan.organizationId !== request.organizationId) {
    return NextResponse.json(
      {
        error: "The plan belongs to a different organisation than this booking",
        code: "PLAN_ORG_MISMATCH",
      },
      { status: 403 },
    );
  }
  return null;
}
