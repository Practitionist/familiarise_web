import { RecordingConsentDecision } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/auth-helpers";
import { resolveMeetingAccess } from "@/lib/meetings/access";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";
import {
  consentRegimeFor,
  getRecordingNotice,
  RECORDING_NOTICE_VERSION,
  recordRecordingConsent,
  type RecordingNotice,
} from "@/lib/stream/recording-consent";
import { RecordingService } from "@/lib/stream/recording-service";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Per-session recording consent (#1134 P1-7).
 *
 * GET  — what notice, if any, this person must be shown before joining.
 * POST — record their decision.
 *
 * Both are gated by resolveMeetingAccess, the same resolver the join gate uses:
 * only someone actually on this appointment may read its notice or record a
 * decision about it. Without that, the endpoint would leak which meeting ids
 * exist and whether they are recorded.
 */

const bodySchema = z.object({
  decision: z.nativeEnum(RecordingConsentDecision),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { meetingId } = await params;
    const access = await resolveMeetingAccess(meetingId, session.user.id);
    if (!access.hasAccess) {
      return NextResponse.json(
        { error: access.message },
        { status: access.reason === "not_found" ? 404 : 403 },
      );
    }

    // Hosts and co-presenters start the recording; only attendees are asked.
    if (access.role === "host") {
      const hostNotice: RecordingNotice = {
        required: false,
        regime: consentRegimeFor(access.appointment),
        noticeVersion: RECORDING_NOTICE_VERSION,
        decision: null,
      };
      return NextResponse.json(hostNotice);
    }

    const notice = await getRecordingNotice(
      access.meetingId,
      session.user.id,
      access.appointment,
    );

    return NextResponse.json(notice);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "recordingConsent.get",
    });
    return NextResponse.json(
      { error: "Could not load the recording notice" },
      { status: 500 },
    );
  }
}

async function stopRecordingOnConsentDecline(
  access: {
    meetingId: string;
    streamCallId?: string | null;
    isRecording?: boolean;
  },
  userId: string,
): Promise<NextResponse | null> {
  let isRecording = access.isRecording;
  let targetCallId = access.streamCallId ?? null;

  if (isRecording === undefined || !targetCallId) {
    const meetingRow = await prisma.meeting?.findUnique?.({
      where: { id: access.meetingId },
      select: { isRecording: true, streamCallId: true },
    });
    if (meetingRow) {
      isRecording ??= meetingRow.isRecording;
      targetCallId ||= meetingRow.streamCallId;
    }
  }

  if (!isRecording) return null;

  if (!targetCallId) {
    const missingCallError = new Error(
      `Missing streamCallId while stopping active recording for meeting ${access.meetingId}`,
    );
    streamLogger.warn(
      "Cannot stop active recording after consent withdrawal — streamCallId missing",
      { meetingId: access.meetingId, userId },
    );
    reportSentryError(missingCallError, {
      subsystem: "stream",
      op: "recordingConsent.stop",
      extra: { meetingId: access.meetingId, userId },
    });
    return NextResponse.json(
      {
        error:
          "Recording could not be stopped — please leave the call while we investigate.",
      },
      { status: 502 },
    );
  }

  const stopResult = await RecordingService.stopRecording(targetCallId, userId);
  if (stopResult.success) {
    await prisma.meeting.update({
      where: { id: access.meetingId },
      data: { isRecording: false },
    });
    return null;
  }

  streamLogger.warn(
    "Failed to stop active recording after consent withdrawal",
    {
      meetingId: access.meetingId,
      streamCallId: targetCallId,
      userId,
      error: stopResult.error,
    },
  );
  reportSentryError(
    new Error(
      stopResult.error ??
        "Failed to stop active recording after consent withdrawal",
    ),
    {
      subsystem: "stream",
      op: "recordingConsent.stop",
      extra: {
        meetingId: access.meetingId,
        streamCallId: targetCallId,
        userId,
      },
    },
  );
  return NextResponse.json(
    {
      error:
        "Recording could not be stopped — please leave the call while we investigate.",
    },
    { status: 502 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { meetingId } = await params;
    const access = await resolveMeetingAccess(meetingId, session.user.id);
    if (!access.hasAccess) {
      return NextResponse.json(
        { error: access.message },
        { status: access.reason === "not_found" ? 404 : 403 },
      );
    }

    // A host decision would veto their own recording, so none is stored.
    if (access.role === "host") {
      return NextResponse.json(
        {
          error: "Hosts do not record a consent decision for their own session",
        },
        { status: 403 },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "decision must be GRANTED or DECLINED" },
        { status: 400 },
      );
    }

    const appointment = access.appointment;
    const notice = await getRecordingNotice(
      access.meetingId,
      session.user.id,
      appointment,
    );

    // Nothing to consent to. Recording is off for this plan, so accepting a
    // decision would write a record implying a choice was offered.
    if (!notice.required) {
      return NextResponse.json(
        { error: "Recording is not enabled for this session" },
        { status: 400 },
      );
    }

    // A group session's recording is the product, disclosed at purchase — the
    // only decision available is acknowledgement. Refusing means not attending
    // (and cancelling for a refund), not attending un-recorded, so DECLINED has
    // no meaning the system could honour.
    if (
      notice.regime === "ACKNOWLEDGE" &&
      parsed.data.decision === RecordingConsentDecision.DECLINED
    ) {
      return NextResponse.json(
        {
          error:
            "This session is recorded as part of what attendees receive. To opt out, cancel your booking for a refund.",
        },
        { status: 409 },
      );
    }

    await recordRecordingConsent(
      access.meetingId,
      session.user.id,
      parsed.data.decision,
    );

    // When a participant in a 1:1 session withdraws consent mid-call while a
    // recording is active, immediately stop the recording so withdrawal takes
    // effect in real time.
    if (parsed.data.decision === RecordingConsentDecision.DECLINED) {
      const stopErrorResponse = await stopRecordingOnConsentDecline(
        access,
        session.user.id,
      );
      if (stopErrorResponse) return stopErrorResponse;
    }

    return NextResponse.json({
      decision: parsed.data.decision,
      regime: notice.regime,
      noticeVersion: notice.noticeVersion,
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "recordingConsent.post",
    });
    return NextResponse.json(
      { error: "Could not record your choice" },
      { status: 500 },
    );
  }
}
