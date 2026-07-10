/**
 * GET /api/organizations/[orgId]/appointments
 *
 * Org-scoped appointments list (#674 / B1-hybrid). MANAGER+ at the org.
 * Forces `scope = org:<orgId>`; calls the same shared service that the
 * personal `/api/appointments?orgScope=...` route uses, so the response
 * shape is identical.
 *
 * Query params: `appointmentType`, `page`, `perPage`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { getOrgAppointments } from "@/lib/data/org-appointments";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  appointmentType: z
    .enum(["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS", "TRIAL"])
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
    appointmentType: url.searchParams.get("appointmentType") ?? undefined,
  });
  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: filters.error.flatten() },
      { status: 400 },
    );
  }
  const pagination = parsePagination(url);

  const result = await getOrgAppointments(orgId, {
    appointmentType: filters.data.appointmentType,
    page: pagination.page,
    perPage: pagination.pageSize,
  });
  return NextResponse.json(result);
}
