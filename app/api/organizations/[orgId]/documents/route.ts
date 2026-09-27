/**
 * GET /api/organizations/[orgId]/documents — the org Library's Documents
 * (#1527), one page of sessions with their files.
 *
 * `?scope=mine` (default): any ACTIVE or SUSPENDED member's own org sessions,
 * with plan materials, their uploads and the other party's, URLs included.
 * `?scope=everyone`: every org session, metadata only (ADR 20) —
 * `operations.read` on an ACTIVE membership.
 *
 * Filters: `q`, `kind`, `from`, `to` (YYYY-MM-DD), `source`, `page`.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { readOrgLibraryDocuments } from "@/lib/data/org-library";
import { libraryRequest } from "@/lib/library/library-route";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { allowSuspended: true });
  if (access.error) return access.error;

  const request = libraryRequest(req, access);
  if (!request.ok) return request.response;
  return NextResponse.json(
    await readOrgLibraryDocuments({ orgId, ...request.args }),
  );
}
