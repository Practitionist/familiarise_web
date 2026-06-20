/**
 * GET /api/organizations/[orgId]/stream/calls
 *
 * Org-scoped Stream call + recording metadata export. MANAGER+ gate
 * because the call log is a compliance surface (who met with whom,
 * when, for how long). Reads from local MeetingSession (indexed by
 * organizationId, #674) rather than Stream's API — every page load
 * would otherwise re-do the join over the network.
 *
 * Recordings are joined eagerly so a dashboard listing 50 calls
 * doesn't fan out 50 separate `listRecordings` HTTP calls. The local
 * `Recording` table is the source of truth for the URL +
 * `streamUrlExpiresAt` — the Stream S3 link expiry policy is what
 * forces our 90-day default retention to be longer-than-Stream so
 * we always have a window to transfer to permanent storage.
 *
 * Every successful GET writes a `STREAM_CALLS_EXPORTED` audit row.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 25)),
  );
  // Only emit recording metadata when the caller asks — most "list
  // calls" hits don't need it and the eager join costs us index
  // hits + bytes on the wire.
  const withRecordings = url.searchParams.get("withRecordings") === "1";

  const where = { organizationId: orgId };

  const [totalResults, sessions] = await prisma.$transaction([
    prisma.meetingSession.count({ where }),
    prisma.meetingSession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        streamCallId: true,
        platform: true,
        isRecording: true,
        recordingStartedAt: true,
        endedAt: true,
        endedReason: true,
        createdAt: true,
        updatedAt: true,
        recordings: withRecordings
          ? {
              select: {
                id: true,
                title: true,
                recordingUrl: true,
                supabaseUrl: true,
                status: true,
                storageType: true,
                durationInMinutes: true,
                streamUrlExpiresAt: true,
                createdAt: true,
              },
            }
          : undefined,
      },
    }),
  ]);

  // Single audit row per export call, not per-row, so the audit log
  // isn't drowned in noise. `details.count` carries the volume.
  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "SYSTEM",
      action: AUDIT_ACTIONS.SYSTEM.STREAM_CALLS_EXPORTED,
      description: `Listed ${sessions.length} Stream calls`,
      details: { page, perPage, count: sessions.length, withRecordings },
    },
  });

  return NextResponse.json({
    data: sessions,
    meta: { totalResults, page, perPage },
  });
}
