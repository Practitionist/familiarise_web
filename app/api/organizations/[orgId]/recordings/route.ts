/**
 * GET /api/organizations/[orgId]/recordings — the org Library's Recordings.
 *
 * `?scope=mine` (default): the member's own org bookings, rows included.
 * `?scope=everyone`: every org booking as counts only — `operations.read`
 * on an ACTIVE membership.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { readRecordingLibrary } from "@/lib/data/recording-library";
import { timedLibraryRead } from "@/lib/library/timed-read";
import { libraryRequest } from "@/lib/library/library-route";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) return access.error;

  const request = libraryRequest(req, access);
  if (!request.ok) return request.response;
  const { userId, scope, query } = request.args;
  return NextResponse.json(
    await timedLibraryRead("recordings:org", () =>
      readRecordingLibrary({
        userId,
        owner: { kind: "org", orgId, everyone: scope === "everyone" },
        query,
      }),
    ),
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
