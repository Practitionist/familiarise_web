/**
 * GET /api/organizations/[orgId]/trials
 *
 * Org-scoped trial-session list (#674 / B1-hybrid). MANAGER+ at the org.
 * Forces `scope = org:<orgId>`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { listTrialsScoped } from "@/lib/api/scope/list-trials";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  status: z
    .enum(["PENDING", "SCHEDULED", "COMPLETED", "CONVERTED", "CANCELLED", "REJECTED"])
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

  const result = await listTrialsScoped({
    scope: { kind: "org", orgId },
    userId: access.session.user.id,
    status: filters.data.status,
    page: pagination.page,
    perPage: pagination.pageSize,
  });
  return NextResponse.json(result);
}
