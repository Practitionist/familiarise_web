import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import {
  mirrorAnsweredQuestionToStreamChannel,
  mirrorChatMessageToStreamChannel,
} from "@/lib/meetings/mirror-room-chat";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { isInCallChatAllowed } from "@/lib/meetings/room-ready";
import {
  ALLOWED_CHAT_EMOJIS,
  canManageStageBanner,
  parseStoredStageChatMessage,
  parseStoredStageQuestion,
  qaActionRequestSchema,
  STAGE_QA_EVENT_TYPES,
  STAGE_QUESTION_TTL_MS,
  STAGE_QUESTION_TTL_SECONDS,
  stageChatIndexRedisKey,
  stageChatReactionKey,
  stageChatRedisKey,
  stageQuestionIndexRedisKey,
  stageQuestionRedisKey,
  stageQuestionUpvotersKey,
  type StageChatMessage,
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

async function resolveAuthorDisplayName(userId: string): Promise<string> {
  const authorRecord = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  return (
    authorRecord?.name?.trim() ||
    authorRecord?.email?.split("@")[0] ||
    "Participant"
  );
}

async function saveStageQuestion(callId: string, question: StageQuestion) {
  const indexKey = stageQuestionIndexRedisKey(callId);
  await Promise.all([
    redis.set(
      stageQuestionRedisKey(callId, question.id),
      JSON.stringify(question),
      { ex: STAGE_QUESTION_TTL_SECONDS },
    ),
    redis.sadd(indexKey, question.id),
  ]);
  await redis.pexpire(indexKey, STAGE_QUESTION_TTL_MS);
}

async function hydrateQuestionWithUpvoters(
  callId: string,
  question: StageQuestion,
): Promise<StageQuestion> {
  const upvoterIds = await redis.smembers(
    stageQuestionUpvotersKey(callId, question.id),
  );
  return {
    ...question,
    upvoterIds,
  };
}

async function saveStageChatMessage(callId: string, message: StageChatMessage) {
  const indexKey = stageChatIndexRedisKey(callId);
  await Promise.all([
    redis.set(stageChatRedisKey(callId, message.id), JSON.stringify(message), {
      ex: STAGE_QUESTION_TTL_SECONDS,
    }),
    redis.sadd(indexKey, message.id),
  ]);
  await redis.pexpire(indexKey, STAGE_QUESTION_TTL_MS);
}

async function hydrateMessageWithReactions(
  callId: string,
  message: StageChatMessage,
): Promise<StageChatMessage> {
  const entries = await Promise.all(
    ALLOWED_CHAT_EMOJIS.map(async (emoji) => {
      const userIds = await redis.smembers(
        stageChatReactionKey(callId, message.id, emoji),
      );
      return [emoji, userIds] as const;
    }),
  );
  const reactions: Record<string, string[]> = {};
  for (const [emoji, userIds] of entries) {
    if (userIds.length > 0) {
      reactions[emoji] = userIds;
    }
  }
  return {
    ...message,
    reactions,
  };
}

async function broadcastCallCustomEvent(
  resolvedCallId: string,
  userId: string,
  custom: Record<string, unknown>,
) {
  await withStreamCircuitBreaker(async () => {
    const call = getStreamVideoClient().video.call(
      STREAM_CALL_TYPE,
      resolvedCallId,
    );
    await call.sendCallEvent({ user_id: userId, custom });
  });
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
 * GET /api/meetings/[meetingId]/qa
 * Hydrates live session Q&A questions (with atomic Redis set upvotes & answers)
 * and room chat messages (with atomic Redis set emoji reactions) so late joiners
 * and browser refreshes restore full session state immediately.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const guard = await guardMeetingRoute(params, "admit to");
    if (!guard.ok) return guard.response;
    const { meetingId, access } = guard;

    const appointmentType = resolveAppointmentType(access.appointment);
    if (!isInCallChatAllowed(appointmentType)) {
      return NextResponse.json(
        {
          error: "Live Q&A and chat are disabled for trial sessions.",
          reason: "trial_chat_disabled",
        },
        { status: 403 },
      );
    }

    const resolvedCallId = toCallId(access.streamCallId ?? meetingId);
    const [questionIds, messageIds] = await Promise.all([
      redis.smembers(stageQuestionIndexRedisKey(resolvedCallId)),
      redis.smembers(stageChatIndexRedisKey(resolvedCallId)),
    ]);

    const [rawQuestions, rawMessages] = await Promise.all([
      Promise.all(
        questionIds.map((id) =>
          redis.get(stageQuestionRedisKey(resolvedCallId, id)),
        ),
      ),
      Promise.all(
        messageIds.map((id) =>
          redis.get(stageChatRedisKey(resolvedCallId, id)),
        ),
      ),
    ]);

    const baseQuestions = rawQuestions
      .map(parseStoredStageQuestion)
      .filter((item): item is StageQuestion => item !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const baseMessages = rawMessages
      .map(parseStoredStageChatMessage)
      .filter((item): item is StageChatMessage => item !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const [questions, messages] = await Promise.all([
      Promise.all(
        baseQuestions.map((q) =>
          hydrateQuestionWithUpvoters(resolvedCallId, q),
        ),
      ),
      Promise.all(
        baseMessages.map((m) => hydrateMessageWithReactions(resolvedCallId, m)),
      ),
    ]);

    return NextResponse.json({
      ok: true,
      questions,
      messages,
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "stream", op: "meetings.qa.get" });
    streamLogger.error("Failed to hydrate meeting Q&A and chat state", error);
    return NextResponse.json(
      { error: "Could not load session Q&A and chat history." },
      { status: 500 },
    );
  }
}

async function loadQuestionOrNotFound(callId: string, questionId: string) {
  const rawStored = await redis.get(stageQuestionRedisKey(callId, questionId));
  return parseStoredStageQuestion(rawStored);
}

function questionNotFoundResponse() {
  return NextResponse.json(
    {
      error: "Question not found or has expired.",
      reason: "question_not_found",
    },
    { status: 404 },
  );
}

async function handleAskAction(
  resolvedCallId: string,
  userId: string,
  role: string | null,
  text: string,
  nowIso: string,
) {
  const authorName = await resolveAuthorDisplayName(userId);
  const question: StageQuestion = {
    id: `qa_${randomUUID()}`,
    text,
    authorId: userId,
    authorName,
    authorRole: role === "host" ? "host" : "participant",
    createdAt: nowIso,
    upvoterIds: [],
    status: "open",
    answerText: null,
    answeredByName: null,
    answeredAt: null,
  };

  await saveStageQuestion(resolvedCallId, question);
  await broadcastCallCustomEvent(resolvedCallId, userId, {
    type: STAGE_QA_EVENT_TYPES.QUESTION_ASKED,
    question,
  });

  return NextResponse.json({
    ok: true,
    action: "ask",
    question,
  });
}

async function handleToggleUpvoteAction(
  resolvedCallId: string,
  userId: string,
  questionId: string,
) {
  const storedQuestion = await loadQuestionOrNotFound(
    resolvedCallId,
    questionId,
  );
  if (!storedQuestion) return questionNotFoundResponse();

  const upvotersKey = stageQuestionUpvotersKey(
    resolvedCallId,
    storedQuestion.id,
  );
  const removed = await redis.srem(upvotersKey, userId);
  if (removed === 0) {
    await redis.sadd(upvotersKey, userId);
  }
  await redis.pexpire(upvotersKey, STAGE_QUESTION_TTL_MS);

  const updated = await hydrateQuestionWithUpvoters(
    resolvedCallId,
    storedQuestion,
  );

  await broadcastCallCustomEvent(resolvedCallId, userId, {
    type: STAGE_QA_EVENT_TYPES.QUESTION_UPDATED,
    question: updated,
  });

  return NextResponse.json({
    ok: true,
    action: "toggle_upvote",
    question: updated,
  });
}

async function handleSendChatAction(
  resolvedCallId: string,
  userId: string,
  role: string | null,
  appointment: Awaited<ReturnType<typeof guardMeetingRoute>> extends
    { ok: false; response: NextResponse } | { ok: true; access: infer A }
    ? A extends { appointment: infer Appt }
      ? Appt
      : never
    : never,
  text: string,
  nowIso: string,
) {
  const authorName = await resolveAuthorDisplayName(userId);
  const messageId = `chat_${randomUUID()}`;

  const initialMessage: StageChatMessage = {
    id: messageId,
    text,
    authorId: userId,
    authorName,
    authorRole: role === "host" ? "host" : "participant",
    createdAt: nowIso,
    reactions: {},
    streamMessageId: null,
  };

  // Persist room message to Redis first so retries never mirror orphaned duplicates to Stream Chat.
  await saveStageChatMessage(resolvedCallId, initialMessage);

  const streamMessageId = await mirrorChatMessageToStreamChannel({
    appointment,
    senderUserId: userId,
    text,
    callId: resolvedCallId,
    roomMessageId: messageId,
  });

  const message: StageChatMessage = streamMessageId
    ? { ...initialMessage, streamMessageId }
    : initialMessage;

  if (streamMessageId) {
    await saveStageChatMessage(resolvedCallId, message);
  }

  await broadcastCallCustomEvent(resolvedCallId, userId, {
    type: STAGE_QA_EVENT_TYPES.CHAT_MESSAGE_SENT,
    message,
  });

  return NextResponse.json({
    ok: true,
    action: "send_chat",
    message,
  });
}

async function handleToggleReactionAction(
  resolvedCallId: string,
  userId: string,
  messageId: string,
  emoji: string,
) {
  const rawStored = await redis.get(
    stageChatRedisKey(resolvedCallId, messageId),
  );
  const storedMessage = parseStoredStageChatMessage(rawStored);
  if (!storedMessage) {
    return NextResponse.json(
      {
        error: "Message not found or has expired.",
        reason: "message_not_found",
      },
      { status: 404 },
    );
  }

  const reactionKey = stageChatReactionKey(
    resolvedCallId,
    storedMessage.id,
    emoji,
  );
  const removed = await redis.srem(reactionKey, userId);
  if (removed === 0) {
    await redis.sadd(reactionKey, userId);
  }
  await redis.pexpire(reactionKey, STAGE_QUESTION_TTL_MS);

  const updated = await hydrateMessageWithReactions(
    resolvedCallId,
    storedMessage,
  );

  await broadcastCallCustomEvent(resolvedCallId, userId, {
    type: STAGE_QA_EVENT_TYPES.CHAT_MESSAGE_UPDATED,
    message: updated,
  });

  return NextResponse.json({
    ok: true,
    action: "toggle_reaction",
    message: updated,
  });
}

async function handleAnswerAction(
  resolvedCallId: string,
  userId: string,
  appointment: Awaited<ReturnType<typeof guardMeetingRoute>> extends
    { ok: false; response: NextResponse } | { ok: true; access: infer A }
    ? A extends { appointment: infer Appt }
      ? Appt
      : never
    : never,
  questionId: string,
  answerText: string | undefined,
  nowIso: string,
) {
  const storedQuestion = await loadQuestionOrNotFound(
    resolvedCallId,
    questionId,
  );
  if (!storedQuestion) return questionNotFoundResponse();

  const answeredByName = await resolveAuthorDisplayName(userId);
  const nextAnswerText =
    answerText?.trim() || storedQuestion.answerText || null;
  const shouldMirrorAnswer =
    storedQuestion.status !== "answered" ||
    storedQuestion.answerText !== nextAnswerText;

  const updatedMeta: StageQuestion = {
    ...storedQuestion,
    status: "answered",
    answerText: nextAnswerText,
    answeredByName,
    answeredAt: nowIso,
  };

  await saveStageQuestion(resolvedCallId, updatedMeta);
  const updated = await hydrateQuestionWithUpvoters(
    resolvedCallId,
    updatedMeta,
  );

  await broadcastCallCustomEvent(resolvedCallId, userId, {
    type: STAGE_QA_EVENT_TYPES.QUESTION_UPDATED,
    question: updated,
  });

  if (shouldMirrorAnswer) {
    await mirrorAnsweredQuestionToStreamChannel({
      appointment,
      hostUserId: userId,
      callId: resolvedCallId,
      question: updated,
    });
  }

  return NextResponse.json({
    ok: true,
    action: "answer",
    question: updated,
  });
}

async function handleReopenAction(
  resolvedCallId: string,
  userId: string,
  questionId: string,
) {
  const storedQuestion = await loadQuestionOrNotFound(
    resolvedCallId,
    questionId,
  );
  if (!storedQuestion) return questionNotFoundResponse();

  const updatedMeta: StageQuestion = {
    ...storedQuestion,
    status: "open",
  };

  await saveStageQuestion(resolvedCallId, updatedMeta);
  const updated = await hydrateQuestionWithUpvoters(
    resolvedCallId,
    updatedMeta,
  );

  await broadcastCallCustomEvent(resolvedCallId, userId, {
    type: STAGE_QA_EVENT_TYPES.QUESTION_UPDATED,
    question: updated,
  });

  return NextResponse.json({
    ok: true,
    action: "reopen",
    question: updated,
  });
}

async function handlePinAction(
  resolvedCallId: string,
  userId: string,
  questionId: string,
  nowIso: string,
) {
  const storedQuestion = await loadQuestionOrNotFound(
    resolvedCallId,
    questionId,
  );
  if (!storedQuestion) return questionNotFoundResponse();

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

async function handleUnpinAction(
  resolvedCallId: string,
  userId: string,
  nowIso: string,
) {
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
}

/**
 * POST /api/meetings/[meetingId]/qa
 * Server-authoritative controller for Live Q&A (`ask`, `toggle_upvote`, `answer`,
 * `reopen`, `pin`, `unpin`) and In-Room Chat + Emoji Reactions (`send_chat`,
 * `toggle_reaction`), backed by atomic Redis sets and canonical Stream Chat
 * channel mirroring.
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

    switch (payload.action) {
      case "ask":
        return await handleAskAction(
          resolvedCallId,
          userId,
          access.role,
          payload.text,
          nowIso,
        );
      case "toggle_upvote":
        return await handleToggleUpvoteAction(
          resolvedCallId,
          userId,
          payload.questionId,
        );
      case "send_chat":
        return await handleSendChatAction(
          resolvedCallId,
          userId,
          access.role,
          access.appointment,
          payload.text,
          nowIso,
        );
      case "toggle_reaction":
        return await handleToggleReactionAction(
          resolvedCallId,
          userId,
          payload.messageId,
          payload.emoji,
        );
      default:
        break;
    }

    if (!canManageStageBanner(access.role)) {
      streamLogger.warn(
        "Host Q&A action refused — caller is not host or co-presenter",
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
            "Only a host or co-presenter can moderate or pin on-screen questions.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    switch (payload.action) {
      case "answer":
        return await handleAnswerAction(
          resolvedCallId,
          userId,
          access.appointment,
          payload.questionId,
          payload.answerText,
          nowIso,
        );
      case "reopen":
        return await handleReopenAction(
          resolvedCallId,
          userId,
          payload.questionId,
        );
      case "pin":
        return await handlePinAction(
          resolvedCallId,
          userId,
          payload.questionId,
          nowIso,
        );
      case "unpin":
        return await handleUnpinAction(resolvedCallId, userId, nowIso);
    }
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
