"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Call } from "@stream-io/video-react-sdk";
import {
  normalizeStageBannerFromCustomData,
  STAGE_QA_EVENT_TYPES,
  stageChatMessageSchema,
  stageQuestionSchema,
  type ChatReactionEmoji,
  type StageChatMessage,
  type StagePinnedBanner,
  type StageQuestion,
} from "@/lib/meetings/stage-qa";

export type SideDrawerTab = "participants" | "chat" | "qa" | null;

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
}

function mergeHydratedByCreatedAt<T extends { id: string; createdAt: string }>(
  hydrated: T[],
  existing: T[],
): T[] {
  const byId = new Map<string, T>();
  for (const item of hydrated) byId.set(item.id, item);
  for (const item of existing) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

interface UseRoomQaAndChatParams {
  call: Call | undefined;
  callCustomData: unknown;
  inCallChatAllowed: boolean;
  isHost: boolean;
  activeSideTab: SideDrawerTab;
}

export function useRoomQaAndChat({
  call,
  callCustomData,
  inCallChatAllowed,
  isHost,
  activeSideTab,
}: UseRoomQaAndChatParams) {
  const [questions, setQuestions] = useState<StageQuestion[]>([]);
  const [chatMessages, setChatMessages] = useState<StageChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [activeBanner, setActiveBanner] = useState<StagePinnedBanner | null>(
    null,
  );
  const [qaError, setQaError] = useState<string | null>(null);
  const [isQaSubmitting, setIsQaSubmitting] = useState(false);

  // Always address meeting API routes with Stream call.id, never DB Meeting.id.
  const targetCallId = call?.id ?? "";
  const activeSideTabRef = useRef<SideDrawerTab>(null);

  useEffect(() => {
    activeSideTabRef.current = activeSideTab;
    if (activeSideTab === "chat") {
      setUnreadChatCount(0);
    }
  }, [activeSideTab]);

  // Hydrate existing room Q&A questions and chat messages on mount or rejoin.
  useEffect(() => {
    if (!targetCallId || !inCallChatAllowed) return;
    let cancelled = false;

    const hydrate = async () => {
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(targetCallId)}/qa`,
        );
        if (!res.ok || cancelled) return;
        const body = await res.json().catch(() => null);
        if (!body || cancelled) return;

        if (Array.isArray(body.questions)) {
          const validQuestions = body.questions
            .map((item: unknown) => stageQuestionSchema.safeParse(item))
            .filter((r: { success: boolean }) => r.success)
            .map((r: { data: StageQuestion }) => r.data);
          setQuestions((prev) =>
            mergeHydratedByCreatedAt(validQuestions, prev),
          );
        }

        if (Array.isArray(body.messages)) {
          const validMessages = body.messages
            .map((item: unknown) => stageChatMessageSchema.safeParse(item))
            .filter((r: { success: boolean }) => r.success)
            .map((r: { data: StageChatMessage }) => r.data);
          setChatMessages((prev) =>
            mergeHydratedByCreatedAt(validMessages, prev),
          );
        }
      } catch {
        // Real-time events remain active even if initial hydration fails transiently.
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [targetCallId, inCallChatAllowed]);

  useEffect(() => {
    if (!inCallChatAllowed) return;
    const syncedBanner = normalizeStageBannerFromCustomData(
      callCustomData as Record<string, unknown> | undefined,
    );
    setActiveBanner(syncedBanner);
  }, [callCustomData, inCallChatAllowed]);

  // Subscribe to real-time Q&A, chat messages, emoji reactions, and stage banner events.
  useEffect(() => {
    if (!call || !inCallChatAllowed || typeof call.on !== "function") return;

    const handleQuestionEvent = (rawQuestion: unknown) => {
      const parsed = stageQuestionSchema.safeParse(rawQuestion);
      if (!parsed.success) return;
      setQuestions((prev) => upsertById(prev, parsed.data));
    };

    const handleChatEvent = (rawMessage: unknown, incrementUnread: boolean) => {
      const parsed = stageChatMessageSchema.safeParse(rawMessage);
      if (!parsed.success) return;
      setChatMessages((prev) => upsertById(prev, parsed.data));
      if (incrementUnread && activeSideTabRef.current !== "chat") {
        setUnreadChatCount((c) => c + 1);
      }
    };

    const handleCustomEvent = (event: { custom?: Record<string, unknown> }) => {
      const custom = event?.custom;
      if (!custom || typeof custom.type !== "string") return;

      switch (custom.type) {
        case STAGE_QA_EVENT_TYPES.QUESTION_ASKED:
        case STAGE_QA_EVENT_TYPES.QUESTION_UPDATED:
          handleQuestionEvent(custom.question);
          break;
        case STAGE_QA_EVENT_TYPES.CHAT_MESSAGE_SENT:
          handleChatEvent(custom.message, true);
          break;
        case STAGE_QA_EVENT_TYPES.CHAT_MESSAGE_UPDATED:
          handleChatEvent(custom.message, false);
          break;
        case STAGE_QA_EVENT_TYPES.BANNER_PINNED: {
          const normalized = normalizeStageBannerFromCustomData({
            activeStageBanner: custom.banner,
          });
          if (normalized) setActiveBanner(normalized);
          break;
        }
        case STAGE_QA_EVENT_TYPES.BANNER_UNPINNED:
          setActiveBanner(null);
          break;
        default:
          break;
      }
    };

    const unsubscribe = call.on("custom", handleCustomEvent as never);
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [call, inCallChatAllowed]);

  const sendQaRequest = useCallback(
    async (
      payload: Record<string, unknown>,
      fallbackError: string,
      trackSubmitting = true,
    ): Promise<Record<string, unknown> | null> => {
      if (!targetCallId) return null;
      setQaError(null);
      if (trackSubmitting) setIsQaSubmitting(true);
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(targetCallId)}/qa`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (!res.ok) {
          setQaError(
            typeof body?.error === "string" ? body.error : fallbackError,
          );
          return null;
        }
        return body;
      } catch (err) {
        setQaError(err instanceof Error ? err.message : fallbackError);
        return null;
      } finally {
        if (trackSubmitting) setIsQaSubmitting(false);
      }
    },
    [targetCallId],
  );

  const handleSendChatMessage = useCallback(
    async (text: string): Promise<boolean> => {
      const body = await sendQaRequest(
        { action: "send_chat", text },
        "Failed to send message",
      );
      if (!body) return false;
      const parsed = stageChatMessageSchema.safeParse(body.message);
      if (parsed.success) {
        setChatMessages((prev) => upsertById(prev, parsed.data));
      }
      return true;
    },
    [sendQaRequest],
  );

  const handleToggleChatReaction = useCallback(
    async (messageId: string, emoji: ChatReactionEmoji) => {
      const body = await sendQaRequest(
        { action: "toggle_reaction", messageId, emoji },
        "Failed to update reaction",
        false,
      );
      if (!body) return;
      const parsed = stageChatMessageSchema.safeParse(body.message);
      if (parsed.success) {
        setChatMessages((prev) => upsertById(prev, parsed.data));
      }
    },
    [sendQaRequest],
  );

  const handleAskQuestion = useCallback(
    async (text: string): Promise<boolean> => {
      const body = await sendQaRequest(
        { action: "ask", text },
        "Failed to send question",
      );
      if (!body) return false;
      const parsed = stageQuestionSchema.safeParse(body.question);
      if (parsed.success) {
        setQuestions((prev) => upsertById(prev, parsed.data));
      }
      return true;
    },
    [sendQaRequest],
  );

  const handleToggleUpvote = useCallback(
    async (questionId: string) => {
      const body = await sendQaRequest(
        { action: "toggle_upvote", questionId },
        "Failed to update vote",
      );
      if (!body) return;
      const parsed = stageQuestionSchema.safeParse(body.question);
      if (parsed.success) {
        setQuestions((prev) => upsertById(prev, parsed.data));
      }
    },
    [sendQaRequest],
  );

  const handleAnswerQuestion = useCallback(
    async (questionId: string, answerText?: string): Promise<boolean> => {
      if (!isHost) return false;
      const body = await sendQaRequest(
        { action: "answer", questionId, answerText },
        "Failed to mark question answered",
      );
      if (!body) return false;
      const parsed = stageQuestionSchema.safeParse(body.question);
      if (parsed.success) {
        setQuestions((prev) => upsertById(prev, parsed.data));
      }
      return true;
    },
    [isHost, sendQaRequest],
  );

  const handleReopenQuestion = useCallback(
    async (questionId: string) => {
      if (!isHost) return;
      const body = await sendQaRequest(
        { action: "reopen", questionId },
        "Failed to reopen question",
      );
      if (!body) return;
      const parsed = stageQuestionSchema.safeParse(body.question);
      if (parsed.success) {
        setQuestions((prev) => upsertById(prev, parsed.data));
      }
    },
    [isHost, sendQaRequest],
  );

  const handlePinQuestion = useCallback(
    async (question: StageQuestion) => {
      if (!isHost) return;
      const body = await sendQaRequest(
        { action: "pin", questionId: question.id },
        "Failed to pin question",
      );
      if (!body) return;
      const normalized = normalizeStageBannerFromCustomData({
        activeStageBanner: body.banner,
      });
      if (normalized) {
        setActiveBanner(normalized);
      }
    },
    [isHost, sendQaRequest],
  );

  const handleUnpinQuestion = useCallback(async () => {
    if (!isHost) return;
    const body = await sendQaRequest(
      { action: "unpin" },
      "Failed to unpin question",
    );
    if (body) {
      setActiveBanner(null);
    }
  }, [isHost, sendQaRequest]);

  return {
    questions,
    chatMessages,
    unreadChatCount,
    activeBanner,
    qaError,
    isQaSubmitting,
    handleSendChatMessage,
    handleToggleChatReaction,
    handleAskQuestion,
    handleToggleUpvote,
    handleAnswerQuestion,
    handleReopenQuestion,
    handlePinQuestion,
    handleUnpinQuestion,
  };
}
