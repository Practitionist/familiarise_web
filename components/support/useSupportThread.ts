"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCaseTimeline } from "./useCaseTimeline";
import { useToast } from "@/hooks/use-toast";
import {
  SupportRequestError,
  throwSupportError,
} from "@/lib/support/error-copy";
import { supportKeys } from "@/lib/support/support-keys";

/**
 * The per-appointment support conversation: flow options, free text and the
 * hand-off to a person. Resolver actions are only displayed, never executed here.
 */

export type Sender = "USER" | "BOT" | "AGENT" | "SYSTEM";

interface MessageMetadata {
  /** The flow node this message was emitted from — the option cursor. */
  nodeId?: string;
  /** `escalates`: the chip hands off to staff, so it asks for a description first. */
  options?: { id: string; label: string; escalates?: boolean }[];
}

export interface ThreadMessage {
  id: string;
  seq?: number;
  sender: Sender;
  body: string;
  metadata?: MessageMetadata | null;
  /** A provider reply that is not Familiarise support. */
  actorKind?: "PRESENTER";
  createdAt: string;
  /** Client-only: shown before the server has confirmed the write. */
  pending?: boolean;
}

export interface SupportThread {
  id: string;
  status: string;
  activeChannel: string;
  category?: string;
  currentNodeId: string | null;
  resolvedAt?: string | null;
  csatRating?: number | null;
  hasMore?: boolean;
  nextBeforeSeq?: number | null;
  messages: ThreadMessage[];
  /** Present once escalated — the deadline committed to at intake. */
  supportTicket?: {
    referenceNumber: string | null;
    ackDueAt: string | null;
    acknowledgedAt?: string | null;
  } | null;
}

/** The booking the conversation is about, shaped by the GET route. */
export interface ThreadBooking {
  title: string | null;
  kind: string;
  startsAt: string | null;
  paymentId: string | null;
  organizationId: string | null;
}

export interface ThreadData {
  thread: SupportThread | null;
  intents: { category: string; title: string; escalates?: boolean }[];
  booking: ThreadBooking | null;
}

export type SupportAction =
  { kind: "OFFER_CANCEL_REFUND"; refundPct: number } | { kind: string };

interface TurnResult {
  status: string;
  activeChannel: string;
  currentNodeId: string | null;
  messages: {
    sender: Sender;
    body: string;
    metadata?: MessageMetadata | null;
  }[];
  escalated: boolean;
  resolved: boolean;
  accepted?: boolean;
  actions: SupportAction[];
  outcomeId?: string | null;
  replyByAt?: string | null;
}

/** One turn's payload, kept so a failed send can be repeated verbatim. */
export interface TurnVars {
  clientTurnId?: string;
  category?: string;
  chosenOptionId?: string;
  userMessage?: string;
  /** The customer flagged the escalation as urgent. */
  urgent?: boolean;
  /** "This didn't fix it": reopens an undecided, recently resolved request. */
  reopen?: boolean;
  /** Client-only echo of what was pressed. Never sent. */
  chosenLabel?: string;
}

/** Ids for locally-rendered bubbles; never collide with the server's uuids. */
let localSeq = 0;
const nextLocalId = () => `local-${++localSeq}`;

/** The one fetcher for this cache entry, so every reader gets one shape. */
export async function fetchSupportThread(
  appointmentId: string,
): Promise<ThreadData> {
  const res = await fetch(`/api/appointments/${appointmentId}/support`);
  if (!res.ok) await throwSupportError(res, "thread load");
  const json = await res.json();
  return {
    thread: json.data,
    intents: json.intents ?? [],
    booking: json.booking ?? null,
  };
}

/** Append bubbles to the cached thread, synthesising a shell thread on the
 *  first turn (the row does not exist until the server writes it). */
function appendMessages(
  old: ThreadData | undefined,
  msgs: (Omit<ThreadMessage, "id" | "createdAt"> & { id?: string })[],
): ThreadData {
  const base: ThreadData = old ?? { thread: null, intents: [], booking: null };
  const thread: SupportThread = base.thread ?? {
    id: "local",
    status: "IN_PROGRESS",
    activeChannel: "SELF_SERVE",
    currentNodeId: null,
    messages: [],
  };
  return {
    ...base,
    thread: {
      ...thread,
      messages: [
        ...thread.messages,
        ...msgs.map((m) => ({
          ...m,
          id: m.id ?? nextLocalId(),
          createdAt: new Date().toISOString(),
        })),
      ],
    },
  };
}

/**
 * "We'll reply by 4:30 PM" beats "soon": a concrete wait is what the hand-off
 * research found cuts abandonment, and this one is a promise already made at
 * intake rather than a guess.
 */
export function describeWait(ackDueAt: string | null | undefined): string {
  const FALLBACK = "Our team will reply here and by email.";
  if (!ackDueAt) return FALLBACK;
  const due = new Date(ackDueAt);
  if (Number.isNaN(due.getTime())) return FALLBACK;
  // Past our own deadline — say so rather than showing a promise that lapsed.
  if (due.getTime() < Date.now()) {
    return "Our team is taking longer than usual. You'll get a reply here and by email.";
  }
  const time = due.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (due.toDateString() === new Date().toDateString()) {
    return `Our team will reply by ${time} today.`;
  }
  const day = due.toLocaleDateString([], { day: "numeric", month: "short" });
  return `Our team will reply by ${time} on ${day}.`;
}

export function describeAction(a: SupportAction): string | null {
  if (a.kind === "OFFER_CANCEL_REFUND") {
    const pct = "refundPct" in a ? a.refundPct : 0;
    return pct > 0
      ? `You're eligible for a ${pct}% refund if you cancel now.`
      : "Cancelling now is outside the refund window — no refund would apply.";
  }
  if (a.kind === "SHOW_INVOICES") {
    return "Invoices and GST receipts live on your Billing page.";
  }
  return null;
}

/** The hand-off divider belongs before the first reply that is actually support. */
export function supportHandoffIndex(
  messages: Pick<ThreadMessage, "sender" | "actorKind">[],
  isHuman: boolean,
): number {
  const firstAgent = messages.findIndex(
    (m) => m.sender === "AGENT" && m.actorKind !== "PRESENTER",
  );
  if (firstAgent >= 0) return firstAgent;
  return isHuman ? messages.length : -1;
}

export function useSupportThread(
  appointmentId: string,
  {
    seedCategory,
    enabled = true,
  }: {
    /**
     * A door that already knows what it is about — "Problem with this charge"
     * opens on PAYMENT_STATUS. Pressed on the user's behalf once, exactly as
     * the option would be; ignored while the thread is with a human or when
     * the intent is gated out.
     */
    seedCategory?: string;
    enabled?: boolean;
  } = {},
) {
  const [lastActions, setLastActions] = useState<SupportAction[]>([]);
  const [lastOutcomeId, setLastOutcomeId] = useState<string | null>(null);
  const [lastReplyByAt, setLastReplyByAt] = useState<string | null>(null);
  const [failedTurns, setFailedTurns] = useState<
    Record<string, { body: string; vars: TurnVars }>
  >({});
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = supportKeys.thread(appointmentId);

  // Undo the optimistic bubble. A turn sent before the first GET resolves has
  // NO snapshot to restore, so the pending bubble is filtered out instead.
  const rollbackOptimistic = (
    previous: ThreadData | undefined,
    optimisticId: string | undefined,
  ) => {
    if (previous) {
      qc.setQueryData(queryKey, previous);
      return;
    }
    if (!optimisticId) return;
    qc.setQueryData<ThreadData>(queryKey, (old) =>
      old?.thread
        ? {
            ...old,
            thread: {
              ...old.thread,
              messages: old.thread.messages.filter(
                (m) => m.id !== optimisticId,
              ),
            },
          }
        : old,
    );
  };

  const turn = useMutation({
    mutationFn: async ({
      chosenLabel: _chosenLabel,
      ...body
    }: TurnVars): Promise<TurnResult> => {
      const current = qc.getQueryData<ThreadData>(queryKey)?.thread;
      if (
        current?.activeChannel === "HUMAN" &&
        current.id !== "local" &&
        body.userMessage &&
        !body.category &&
        !body.chosenOptionId
      ) {
        const res = await fetch(`/api/support/cases/${current.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: body.userMessage,
            clientTurnId: body.clientTurnId,
            ...(body.reopen ? { reopen: true } : {}),
          }),
        });
        if (!res.ok) await throwSupportError(res, "support reply");
        // A plain reply is a follow-up; only "This didn't fix it" reopens.
        return {
          status:
            body.reopen && current.status === "RESOLVED"
              ? "OPEN"
              : current.status,
          activeChannel: "HUMAN",
          currentNodeId: current.currentNodeId,
          messages: [],
          escalated: false,
          resolved: false,
          actions: [],
        };
      }
      const res = await fetch(`/api/appointments/${appointmentId}/support`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) await throwSupportError(res, "support turn");
      const { data } = await res.json();
      return data;
    },
    // Echo the user's turn immediately: two serial round trips on a cold
    // instance otherwise read as the tap having missed.
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<ThreadData>(queryKey);
      const said = vars.userMessage ?? vars.chosenLabel;
      let optimisticId: string | undefined;
      if (said) {
        optimisticId = nextLocalId();
        qc.setQueryData<ThreadData>(queryKey, (old) =>
          appendMessages(old, [
            { id: optimisticId, sender: "USER", body: said, pending: true },
          ]),
        );
      }
      return { previous, optimisticId };
    },
    onSuccess: (result, vars, context) => {
      // The server took the request but refused the write: treat it exactly
      // like a failure, or the bubble sits there looking delivered.
      if (result.accepted === false) {
        const id = context?.optimisticId;
        const said = vars.userMessage ?? vars.chosenLabel;
        rollbackOptimistic(context?.previous, id);
        if (id && said)
          setFailedTurns((f) => ({ ...f, [id]: { body: said, vars } }));
        toast({
          title: "Support",
          description:
            "Support has closed this conversation, so your message wasn't sent. Start a new support case from Support.",
          variant: "destructive",
        });
        return;
      }
      setLastActions(result.actions ?? []);
      if (result.outcomeId !== undefined) {
        setLastOutcomeId(result.outcomeId ?? null);
      }
      if (result.replyByAt !== undefined) {
        setLastReplyByAt(result.replyByAt ?? null);
      }
      qc.setQueryData<ThreadData>(queryKey, (old) => {
        const merged = appendMessages(
          old,
          result.messages.map((m) => ({
            sender: m.sender,
            body: m.body,
            metadata: m.metadata ?? null,
          })),
        );
        if (!merged.thread) return merged;
        return {
          ...merged,
          thread: {
            ...merged.thread,
            status: result.status,
            activeChannel: result.activeChannel,
            currentNodeId: result.currentNodeId,
            messages: merged.thread.messages.map((m) =>
              m.pending ? { ...m, pending: false } : m,
            ),
          },
        };
      });
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: unknown, vars, context) => {
      // Keep the message where the user put it, marked failed, with a retry.
      // A DEFINITE refusal (403/404/400) is different: a retry returns the
      // same answer, so the bubble goes and the reason is shown instead.
      const id = context?.optimisticId;
      const said = vars.userMessage ?? vars.chosenLabel;
      if (e instanceof SupportRequestError && e.isDefinite) {
        rollbackOptimistic(context?.previous, id);
        toast({
          title: "Support",
          description: e.message,
          variant: "destructive",
        });
        return;
      }
      if (id && said) {
        rollbackOptimistic(context?.previous, id);
        setFailedTurns((f) => ({ ...f, [id]: { body: said, vars } }));
      } else {
        toast({
          title: "Support",
          description: e instanceof Error ? e.message : "Please try again.",
          variant: "destructive",
        });
      }
    },
  });

  const query = useQuery({
    queryKey,
    enabled,
    refetchIntervalInBackground: false,
    refetchInterval: (q) => {
      if (turn.isPending) return false;
      const status = q.state.data?.thread?.status;
      return status === "RESOLVED" || status === "CLOSED" ? false : 15_000;
    },
    queryFn: () => fetchSupportThread(appointmentId),
  });
  const data = query.data;
  const thread = data?.thread ?? null;

  const availableIntents = data
    ? data.intents.map((i) => ({
        category: i.category,
        label: i.title,
        escalates: i.escalates,
      }))
    : [];

  const latestMessages = thread?.messages ?? [];
  const history = useCaseTimeline(
    thread?.id ?? "unstarted",
    latestMessages.map((message) => ({
      id: message.id,
      seq: message.seq,
      author: message.sender,
      authorName: null,
      body: message.body,
      internal: false,
      actorKind: message.actorKind,
      at: message.createdAt,
    })),
    thread?.nextBeforeSeq,
    thread?.hasMore,
  );
  const latestById = new Map(
    latestMessages.map((message) => [message.id, message]),
  );
  const messages: ThreadMessage[] = history.timeline.map(
    (message) =>
      latestById.get(message.id) ?? {
        id: message.id,
        seq: message.seq,
        sender: message.author,
        body: message.body,
        actorKind: message.actorKind,
        createdAt: message.at,
      },
  );
  const isHuman = thread?.activeChannel === "HUMAN";
  const isResolved = thread?.status === "RESOLVED";
  const isClosed = thread?.status === "CLOSED";
  // Options come from the message AT the server's cursor, not whichever BOT
  // message happens to be last; those two can drift.
  const cursor = thread?.currentNodeId ?? null;
  const activePrompt = cursor
    ? [...messages]
        .reverse()
        .find((m) => m.sender === "BOT" && m.metadata?.nodeId === cursor)
    : undefined;
  const options =
    !isHuman && !isResolved ? (activePrompt?.metadata?.options ?? []) : [];

  // A ref flips synchronously, so two clicks in one tick can't both fire.
  const inFlight = useRef(false);
  const { mutate: mutateTurn } = turn;
  const submitTurn = useCallback(
    (vars: TurnVars): boolean => {
      if (inFlight.current) return false;
      inFlight.current = true;
      mutateTurn(
        { ...vars, clientTurnId: vars.clientTurnId ?? crypto.randomUUID() },
        { onSettled: () => (inFlight.current = false) },
      );
      return true;
    },
    [mutateTurn],
  );
  const retryTurn = (id: string) => {
    const failed = failedTurns[id];
    // Check the in-flight guard BEFORE dropping the entry, or a Retry pressed
    // during another send erases the message and never resends it.
    if (!failed || inFlight.current) return;
    setFailedTurns(({ [id]: _gone, ...rest }) => rest);
    submitTurn(failed.vars);
  };

  const seeded = useRef(false);
  useEffect(() => {
    if (!seedCategory || seeded.current || !data) return;
    const t = data.thread;
    const intent = data.intents.find((i) => i.category === seedCategory);
    // Seed only a fresh or resolved thread, so a remount never repeats the intent turn.
    if ((t && t.status !== "RESOLVED") || !intent) {
      seeded.current = true;
      return;
    }
    if (submitTurn({ category: intent.category, chosenLabel: intent.title })) {
      seeded.current = true;
    }
  }, [seedCategory, data, submitTurn]);

  // The hand-off sits immediately before the first staff AGENT message; a
  // presenter reply is not support, and an escalated thread with no staff reply
  // yet gets it at the end.
  const handoffIndex = supportHandoffIndex(messages, isHuman);

  return {
    query,
    data,
    thread,
    messages,
    history,
    availableIntents,
    options,
    isHuman,
    isResolved,
    isClosed,
    started: !!thread,
    turnPending: turn.isPending,
    submitTurn,
    failedTurns,
    retryTurn,
    lastActions,
    lastOutcomeId,
    // Null once the team has replied or the case is settled: no reply is owed then.
    waitingLine:
      isHuman &&
      !isResolved &&
      !isClosed &&
      !thread?.supportTicket?.acknowledgedAt
        ? describeWait(thread?.supportTicket?.ackDueAt ?? lastReplyByAt)
        : null,
    handoffIndex,
  };
}
