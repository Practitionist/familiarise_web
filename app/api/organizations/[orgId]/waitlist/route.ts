/**
 * GET /api/organizations/[orgId]/waitlist
 *
 * Org-scoped waitlist list (#674 / B1-hybrid). MANAGER+ at the org.
 * Forces `scope = org:<orgId>`. Mirrors `/api/organizations/[orgId]/appointments`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { listWaitlistScoped } from "@/lib/api/scope/list-waitlist";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  status: z
    .enum(["WAITING", "NOTIFIED", "EXPIRED", "BOOKED", "CANCELLED"])
    .optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "operations.read" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const filters = QuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: filters.error.flatten() },
      { status: 400 },
    );
  }
  const pagination = parsePagination(url);

  const result = await listWaitlistScoped({
    scope: { kind: "org", orgId },
    userId: access.session.user.id,
    status: filters.data.status,
    page: pagination.page,
    perPage: pagination.pageSize,
  });
  return NextResponse.json(result);
}
