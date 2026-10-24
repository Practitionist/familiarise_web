/**
 * Sync Recordings API Route
 * POST /api/stream/recordings/sync
 *
 * Mirrors Stream's recordings for the caller's sessions of the last 30 days,
 * 25 meetings per identity per call, and never sends a notification.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import { applyRateLimit, streamRecordingSyncLimiter } from "@/lib/rate-limit";
import {
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";

import { getSession } from "@/lib/auth-server";

/** Each identity pages independently; omit a cursor to start from the newest meeting. */
const syncBodySchema = z
  .object({
    consultantCursor: z.string().min(1).optional(),
    consulteeCursor: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export async function POST(req: NextRequest) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user) return fileApiError("UNAUTHORIZED");

    // #1270 — keyed on the user, after auth and before any Stream work. This
    // route is one cheap POST that fans out a `listRecordings` call to Stream
    // for every session the caller touches, so it was an unbounded, billable
    // amplifier for any authenticated account. The edge `stream: api` rule
    // covers the path but is IP-keyed at 60/min, which neither identifies the
    // caller nor reflects what this endpoint costs to serve.
    const limited = await applyRateLimit(
      streamRecordingSyncLimiter,
      `recordings-sync:${session.user.id}`,
    );
    if (limited) return limited;

    const { consultantCursor, consulteeCursor } =
      (await parseJsonBody(req, syncBodySchema)) ?? {};

    // Capability, not UserRole (#org-appts): an org EXPERT whose top-level role is CONSULTEE still owns recordings they delivered.
    const consultant = session.user.consultantProfileId
      ? await RecordingService.syncRecordingsForConsultant(
          session.user.consultantProfileId,
          { cursor: consultantCursor },
        )
      : null;
    const consultee = session.user.consulteeProfileId
      ? await RecordingService.syncRecordingsForConsultee(session.user.id, {
          cursor: consulteeCursor,
        })
      : null;

    if (!consultant && !consultee) return fileApiError("FORBIDDEN");

    const recordings = [
      ...(consultant?.recordings ?? []),
      ...(consultee?.recordings ?? []),
    ];
    const nextCursors = {
      consultantCursor: consultant?.nextCursor ?? null,
      consulteeCursor: consultee?.nextCursor ?? null,
    };

    return NextResponse.json({
      success: true,
      synced: recordings.length,
      failed: (consultant?.failed ?? 0) + (consultee?.failed ?? 0),
      more: Boolean(
        nextCursors.consultantCursor || nextCursors.consulteeCursor,
      ),
      ...nextCursors,
      recordings: recordings.map((r) => ({
        id: r.id,
        title: r.title,
        durationInMinutes: r.durationInMinutes,
        recordedAt: r.recordedAt,
        status: r.status,
      })),
    });
  }, "stream");
}
