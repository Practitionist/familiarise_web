import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import {
  forbiddenResponse,
  isPrivileged,
  requireApiAuth,
} from "@/lib/auth-helpers";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import { parseRequestListQueryOrRespond } from "@/lib/booking/request-route-guards";
import {
  INBOX_CHIPS,
  INBOX_DEFAULT_LIMIT,
  INBOX_DEFAULT_SORT,
  INBOX_DEFAULT_TYPE,
  INBOX_SORTS,
  INBOX_TYPES,
} from "@/lib/dashboard/requests-inbox-state";
import { readRequestsInbox } from "@/lib/data/requests-inbox";

/**
 * GET /api/bookings/inbox — the Requests inbox's HTTP twin (#1775). The RSC
 * page seeds react-query through `readRequestsInbox` directly; every refetch
 * comes here with the same arguments and gets the same payload. Auth and
 * org-scope resolution mirror `/api/bookings/consultations`: a consultant
 * reads only their own profile, ADMIN/STAFF may read any.
 */

/** The inbox's own keys; page/limit ride the shared list-query contract. */
const InboxQuerySchema = z.object({
  consultantProfileId: z.string().min(1),
  type: z.enum(INBOX_TYPES).default(INBOX_DEFAULT_TYPE),
  chip: z.enum(INBOX_CHIPS).optional(),
  sort: z.enum(INBOX_SORTS).default(INBOX_DEFAULT_SORT),
});

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { searchParams } = new URL(request.url);
    const listQuery = parseRequestListQueryOrRespond(searchParams);
    if (listQuery.response) return listQuery.response;

    const raw: Record<string, string> = {};
    for (const key of [
      "consultantProfileId",
      "type",
      "chip",
      "sort",
    ] as const) {
      const value = searchParams.get(key);
      if (value !== null) raw[key] = value;
    }
    const parsed = InboxQuerySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json(
        {
          error: issue
            ? `${issue.path.join(".")}: ${issue.message}`
            : "Invalid query",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }
    const { consultantProfileId, type, chip, sort } = parsed.data;

    if (
      !isPrivileged(session.user.role) &&
      consultantProfileId !== session.user.consultantProfileId
    ) {
      return forbiddenResponse("Access denied");
    }

    // Absent → personal, as the list routes default; an explicit org id
    // resolves against the caller's memberships (#674).
    const rawOrgScope = searchParams.get("orgScope");
    let orgScope: Parameters<typeof readRequestsInbox>[0]["orgScope"];
    if (rawOrgScope && rawOrgScope !== "mine" && rawOrgScope !== "personal") {
      const memberships = await prisma.membership.findMany({
        where: { userId: session.user.id, status: "ACTIVE" },
        select: { organizationId: true, status: true, role: true },
      });
      const resolution = resolveOrgScope({
        raw: rawOrgScope,
        memberships,
        userRole: session.user.role,
        userId: session.user.id,
        allowAllForOwner: true,
      });
      if (!resolution.ok) {
        return NextResponse.json(
          { error: resolution.message, code: resolution.code },
          { status: resolution.status },
        );
      }
      orgScope = resolution.scope;
    }

    const payload = await readRequestsInbox({
      consultantProfileId,
      orgScope,
      type,
      chip,
      sort,
      page: listQuery.query.page,
      limit:
        searchParams.get("limit") === null
          ? INBOX_DEFAULT_LIMIT
          : listQuery.query.limit,
    });
    // Money truth is never cached (#1775).
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while fetching the requests inbox" },
      { status: 500 },
    );
  }
}
