/**
 * GET /api/organizations/[orgId]/recordings — the org Library's Recordings
 * (#1527), one page of sessions with their recordings.
 *
 * `?scope=mine` (default): any ACTIVE or SUSPENDED member's own org sessions,
 * playable, with the #1819 late-join rule applied as on the consultee read.
 * `?scope=everyone`: every org session, metadata only (ADR 20) —
 * `operations.read` on an ACTIVE membership.
 *
 * Filters: `q`, `kind`, `from`, `to` (YYYY-MM-DD), `page`.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { readOrgLibraryRecordings } from "@/lib/data/org-library";
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
    await readOrgLibraryRecordings({ orgId, ...request.args }),
  );
}
