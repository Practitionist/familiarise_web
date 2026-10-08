import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { isInCallChatAllowed } from "@/lib/meetings/room-ready";
import {
  canManageStageBanner,
  parseStoredStageQuestion,
  qaActionRequestSchema,
  STAGE_QA_EVENT_TYPES,
  STAGE_QUESTION_TTL_SECONDS,
  stageQuestionRedisKey,
  type StagePinnedBanner,
  type StageQuestion,
} from "@/lib/meetings/stage-qa";
import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import redis from "@/lib/redis";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";

function resolveAppointmentType(
  appointment:
    | {
        appointmentType?: string | null;
        webinar?: unknown;
        class?: unknown;
      }
    | null
    | undefined,
): string | null {
  if (appointment?.appointmentType) {
    return appointment.appointmentType;
  }
  if (appointment?.webinar) {
    return "WEBINAR";
  }
  if (appointment?.class) {
    return "CLASS";
  }
  return null;
}

async function updateCallStageBanner(
  resolvedCallId: string,
  banner: StagePinnedBanner | null,
) {
  const call = getStreamVideoClient().video.call(
    STREAM_CALL_TYPE,
    resolvedCallId,
  );
  const current = await call.get();
  const existingCustom =
    current?.call?.custom && typeof current.call.custom === "object"
      ? current.call.custom
      : {};

  await call.update({
    custom: {
      ...existingCustom,
      activeStageBanner: banner,
    },
  });

  return call;
}

/**
 * POST /api/meetings/[meetingId]/qa
 *
 * Server-authoritative Live Q&A and 1-Click "ON SCREEN" Stage Banner controller.
 * - `action: "ask"`: Any authenticated, consented meeting participant or host on a
 *   non-TRIAL session submits a question over the live Stream WebSocket (`sendCallEvent`)
 *   with verified server-side author identity, stored in Redis for server-verified pinning.
 * - `action: "pin" | "unpin"`: Restricted strictly to verified hosts & co-presenters
 *   (`access.role === "host"`). Broadcasts the `ON SCREEN` lower-third banner immediately
 *   over the Stream WebSocket AND persists `custom.activeStageBanner` (while preserving
 *   existing `custom` fields such as `organizationId`) so late-joining attendees see the
 *   active stage banner upon entry.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "admit to");
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    const appointmentType = resolveAppointmentType(access.appointment);

    if (!isInCallChatAllowed(appointmentType)) {
      return NextResponse.json(
        {
          error: "Live Q&A is disabled for trial sessions.",
          reason: "trial_chat_disabled",
        },
        { status: 403 },
      );
    }

    const rawBody = await req.json().catch(() => null);
    const parsed = qaActionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid Q&A request payload.",
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const payload = parsed.data;
    const resolvedCallId = toCallId(access.streamCallId ?? meetingId);
    const nowIso = new Date().toISOString();

    if (payload.action === "ask") {
      const authorRecord = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      const authorName =
        authorRecord?.name?.trim() ||
        authorRecord?.email?.split("@")[0] ||
        "Participant";

      const question: StageQuestion = {
        id: `qa_${randomUUID()}`,
        text: payload.text,
        authorId: userId,
        authorName,
        authorRole: access.role === "host" ? "host" : "participant",
        createdAt: nowIso,
      };

      await redis.set(
        stageQuestionRedisKey(resolvedCallId, question.id),
        JSON.stringify(question),
        { ex: STAGE_QUESTION_TTL_SECONDS },
      );

      await withStreamCircuitBreaker(async () => {
        const call = getStreamVideoClient().video.call(
          STREAM_CALL_TYPE,
          resolvedCallId,
        );
        await call.sendCallEvent({
          user_id: userId,
          custom: {
            type: STAGE_QA_EVENT_TYPES.QUESTION_ASKED,
            question,
          },
        });
      });

      return NextResponse.json({
        ok: true,
        action: "ask",
        question,
      });
    }

    if (!canManageStageBanner(access.role)) {
      streamLogger.warn(
        "Stage banner update refused — caller is not host or co-presenter",
        {
          userId,
          meetingId,
          role: access.role,
          action: payload.action,
        },
      );
      return NextResponse.json(
        {
          error:
            "Only a host or co-presenter can pin or clear on-screen questions.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    if (payload.action === "pin") {
      const rawStored = await redis.get(
        stageQuestionRedisKey(resolvedCallId, payload.questionId),
      );
      const storedQuestion = parseStoredStageQuestion(rawStored);
      if (!storedQuestion) {
        return NextResponse.json(
          {
            error: "Question not found or has expired.",
            reason: "question_not_found",
          },
          { status: 404 },
        );
      }

      const banner: StagePinnedBanner = {
        questionId: storedQuestion.id,
        text: storedQuestion.text,
        authorId: storedQuestion.authorId,
        authorName: storedQuestion.authorName,
        authorRole: storedQuestion.authorRole,
        pinnedByUserId: userId,
        pinnedAt: nowIso,
      };

      await withStreamCircuitBreaker(async () => {
        const call = await updateCallStageBanner(resolvedCallId, banner);
        await call.sendCallEvent({
          user_id: userId,
          custom: {
            type: STAGE_QA_EVENT_TYPES.BANNER_PINNED,
            banner,
          },
        });
      });

      streamLogger.info("Pinned Q&A question on stage", {
        hostUserId: userId,
        questionId: banner.questionId,
        meetingId: resolvedCallId,
      });

      return NextResponse.json({
        ok: true,
        action: "pin",
        banner,
      });
    }

    // payload.action === "unpin"
    await withStreamCircuitBreaker(async () => {
      const call = await updateCallStageBanner(resolvedCallId, null);
      await call.sendCallEvent({
        user_id: userId,
        custom: {
          type: STAGE_QA_EVENT_TYPES.BANNER_UNPINNED,
          unpinnedByUserId: userId,
          unpinnedAt: nowIso,
        },
      });
    });

    streamLogger.info("Cleared pinned Q&A banner from stage", {
      hostUserId: userId,
      meetingId: resolvedCallId,
    });

    return NextResponse.json({
      ok: true,
      action: "unpin",
      banner: null,
    });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting Q&A unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        {
          error: "Video service is temporarily unavailable. Please try again.",
        },
        { status: 503 },
      );
    }

    reportSentryError(error, { subsystem: "stream", op: "meetings.qa" });
    streamLogger.error("Failed to process meeting Q&A action", error);
    return NextResponse.json(
      { error: "Could not process Q&A action. Please try again." },
      { status: 500 },
    );
  }
}
