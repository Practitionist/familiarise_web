/**
 * GET /api/staff/support-inbox/[caseKey] — #1527 one case's workspace: the
 * person, booking, payment and org context, past cases, and the unified
 * timeline (private notes included — this route is staff-only). Email and
 * payment are shaped by the viewer's own grants; mutations stay on the
 * existing ticket and thread routes and their guards.
 */

import type { UserRole } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { supportError } from "@/lib/api/support-http";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { parseCaseKey } from "@/lib/support/case-key";
import { readCaseWorkspace } from "@/lib/support/case-workspace";

const ROUTE = "staff.support-inbox.case";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ caseKey: string }> },
) {
  const auth = await requireBackofficeSurface("tickets.manage");
  if (auth.error) return auth.error;
  const { caseKey } = await params;
  const ref = parseCaseKey(caseKey);
  if (!ref || ref.kind === "booking") {
    return supportError({
      status: 404,
      code: "NOT_FOUND",
      context: { route: ROUTE },
    });
  }
  try {
    const role = auth.session.user.role as UserRole;
    const data = await readCaseWorkspace(ref, {
      showEmail: hasBackofficePermission(role, "users.read"),
      showPayment: hasBackofficePermission(role, "payments.read"),
    });
    if (!data) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "This case doesn't exist",
        context: { route: ROUTE, caseKey },
      });
    }
    const updatedAtMs = Date.parse(data.updatedAt ?? data.createdAt);
    const etag = `W/"${data.status}-${updatedAtMs}-${data.timeline.length}"`;
    const headers = {
      ETag: etag,
      "Cache-Control": "private, no-cache",
    };
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json({ data }, { headers });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: ROUTE, caseKey },
    });
  }
}
