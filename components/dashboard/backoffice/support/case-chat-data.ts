"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { fetchWithReauth } from "@/lib/auth/reauth-client";
import { invalidateSupportCase, supportKeys } from "@/lib/support/support-keys";
import {
  ChatGrantSchema,
  ChatStatusSchema,
  SupportChatActionBody,
  TranscriptPageSchema,
  type ChatGrant,
  type ChatStatus,
  type SupportChatInterventionBasis,
  type TranscriptPage,
} from "@/schemas/support-chat";

export const BASIS_LABEL: Record<ChatGrant["basis"], string> = {
  OPEN_CASE: "Open case",
  EVIDENCE_OVERDUE: "Evidence overdue",
  SAFETY: "Safety concern",
  FRAUD_OR_SCAM: "Fraud or scam",
};

/** Bases staff may assert without the server having verified them. */
export const ASSERTABLE_BASES: ReadonlySet<SupportChatInterventionBasis> =
  new Set(["SAFETY", "FRAUD_OR_SCAM"]);

export const chatKeys = {
  status: (caseId: string) => [...supportKeys.case(caseId), "chat"] as const,
  // Outside the case subtree so case invalidations never re-read the transcript unasked.
  transcript: (caseId: string, grantId: string) =>
    ["support-chat-transcript", caseId, grantId] as const,
};

const Refusal = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});

/** A refusal from a chat route, carrying the server's own `error` text and `code`. */
export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

async function refuse(response: Response, fallback: string): Promise<never> {
  const parsed = Refusal.safeParse(await response.json().catch(() => null));
  const body = parsed.success ? parsed.data : {};
  throw new ChatRequestError(
    body.error ?? fallback,
    response.status,
    body.code,
  );
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** The case's chat eligibility and grants; null when the viewer may not read chats (403). */
export function useChatStatus(caseId: string) {
  return useQuery({
    queryKey: chatKeys.status(caseId),
    queryFn: async (): Promise<ChatStatus | null> => {
      const response = await fetch(`/api/support/cases/${caseId}/chat`);
      if (response.status === 403) return null;
      if (!response.ok)
        await refuse(response, "The booking chat status didn't load.");
      return z.object({ data: ChatStatusSchema }).parse(await response.json())
        .data;
    },
  });
}

export const liveIntervention = (status: ChatStatus) =>
  status.grants.find((grant) => grant.live && grant.kind === "INTERVENE");

export type ChatActionPayload = z.infer<typeof SupportChatActionBody> & {
  reason: string;
};

const ActionResponse = z.object({
  grant: ChatGrantSchema.optional(),
  opsActionId: z.string(),
});

const ACTION_DONE: Record<ChatActionPayload["action"], string> = {
  OPEN_READ: "Chat access opened",
  START_INTERVENTION: "Familiarise Support is joining the chat",
  END_READ: "Chat access ended",
  END_INTERVENTION: "Familiarise Support left the chat",
};

/** One chat grant door; step-up 403s go through the re-auth dialog and retry once. */
export function useChatAction(caseId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (payload: ChatActionPayload) => {
      const response = await fetchWithReauth(
        `/api/support/cases/${caseId}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok)
        await refuse(response, "The chat action was not completed.");
      return ActionResponse.parse(await response.json());
    },
    onSuccess: (_result, payload) => {
      toast({ title: ACTION_DONE[payload.action] });
      if (
        payload.action === "END_READ" ||
        payload.action === "END_INTERVENTION"
      )
        qc.removeQueries({
          queryKey: chatKeys.transcript(caseId, payload.grantId),
        });
    },
    onSettled: () => invalidateSupportCase(qc, caseId),
  });
}

/** Transcript pages, newest first; fetched only on mount, "Load earlier" and "Refresh". */
export function useTranscript(caseId: string, grantId: string) {
  return useInfiniteQuery({
    queryKey: chatKeys.transcript(caseId, grantId),
    initialPageParam: null as string | null,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | null;
    }): Promise<TranscriptPage> => {
      const params = new URLSearchParams({ grantId });
      if (pageParam) params.set("before", pageParam);
      const response = await fetch(
        `/api/support/cases/${caseId}/chat/transcript?${params.toString()}`,
      );
      if (!response.ok)
        await refuse(response, "The chat transcript didn't load.");
      return z
        .object({ data: TranscriptPageSchema })
        .parse(await response.json()).data;
    },
    getNextPageParam: (last) => last.nextBefore,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/** An idempotency key for one composer draft, in the server's `[A-Za-z0-9_-]{8,40}` shape. */
export const newClientActionId = () =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 40);

const PostedMessage = z.object({
  data: z.object({ messageId: z.string(), replayed: z.boolean() }),
});

export function usePostSupportMessage(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      grantId: string;
      clientActionId: string;
      text: string;
    }) => {
      const response = await fetchWithReauth(
        `/api/support/cases/${caseId}/chat/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok)
        await refuse(response, "The message was not sent. Try again.");
      return PostedMessage.parse(await response.json()).data;
    },
    onSuccess: (_result, body) =>
      qc.invalidateQueries({
        queryKey: chatKeys.transcript(caseId, body.grantId),
      }),
    onError: (error) => {
      if (error instanceof ChatRequestError && error.code === "GRANT_ENDED")
        void qc.invalidateQueries({ queryKey: chatKeys.status(caseId) });
    },
  });
}
