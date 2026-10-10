"use client";

/**
 * #support-hub — the PLATFORM-scope support intake. A Sheet that runs the
 * stateless flowchart: the client holds the cursor for the length of one
 * sitting and replays it to the server each turn; the server validates every
 * transition (the client is never trusted) and either answers self-serve or
 * escalates — the only write, a SupportTicket via the shared factory.
 *
 * Deliberately NOT Stream, NOT persisted: platform flows are short (1–3
 * steps); the escalated outcome lives in the ops queue, and "My requests"
 * shows the result. See lib/support/platform-flows.ts for the registry.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, Send, CheckCircle2, Ticket } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { isBareHumanRequest } from "@/lib/support/escalation";
import { throwSupportError } from "@/lib/support/error-copy";
import { describeWait } from "./useSupportThread";

type Sender = "USER" | "BOT" | "AGENT" | "SYSTEM";

interface LocalMessage {
  id: string;
  sender: Sender;
  body: string;
  options?: { id: string; label: string }[];
  /** Rendered before the server has answered — see `onMutate`. */
  pending?: boolean;
}

/** Ids for locally-held bubbles. This scope persists nothing, so every message
 *  needs one: an array index reuses DOM nodes positionally and cannot key a
 *  bubble that is later replaced in place. */
let localSeq = 0;
const nextLocalId = () => `local-${++localSeq}`;

const HUMAN_EXIT_LABEL = "Talk to a person";

interface PlatformFlow {
  id: string;
  title: string;
  description: string;
}

interface TurnResponse {
  messages: {
    sender: string;
    body: string;
    metadata?: { options?: { id: string; label: string }[] } | null;
  }[];
  nextNodeId: string | null;
  actions?: { kind: string }[];
  resolved: boolean;
  escalated: boolean;
  supportTicketId?: string;
  supportTicketReference?: string | null;
  outcomeId?: string | null;
  replyByAt?: string | null;
}

export function PlatformSupportSheet({
  open: controlledOpen,
  onOpenChange,
  trigger,
  orgId,
  requestHref,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  orgId?: string;
  requestHref?: (ticketId: string) => string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    onOpenChange?.(v);
    if (controlledOpen === undefined) setInternalOpen(v);
  };
  const [text, setText] = useState("");
  const sittingRef = useRef(0);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [visitedNodeIds, setVisitedNodeIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [done, setDone] = useState<{
    resolved: boolean;
    ticketId?: string;
    ticketReference?: string | null;
    outcomeId?: string | null;
    replyByAt?: string | null;
    collectFeedback?: boolean;
  } | null>(null);
  const [flowRating, setFlowRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  const [bareHumanLabel, setBareHumanLabel] = useState<string | null>(null);
  const [bareHumanDetails, setBareHumanDetails] = useState("");
  const [bareHumanUrgent, setBareHumanUrgent] = useState(false);
  const [offline, setOffline] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  useEffect(() => {
    setOffline(!navigator.onLine);
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  const catalog = useQuery({
    queryKey: ["platform-support-intents"],
    enabled: open,
    queryFn: async (): Promise<PlatformFlow[]> => {
      const res = await fetch("/api/support/platform");
      if (!res.ok) await throwSupportError(res, "support topics load");
      const { data } = await res.json();
      return data.flows;
    },
  });

  const turn = useMutation({
    mutationFn: async ({
      epoch: _epoch,
      chosenLabel: _chosenLabel,
      ...body
    }: {
      flowId: string;
      nodeId?: string | null;
      chosenOptionId?: string;
      userMessage?: string;
      urgent?: boolean;
      epoch: number;
      chosenLabel?: string;
    }): Promise<TurnResponse> => {
      const res = await fetch("/api/support/platform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          visitedNodeIds,
          orgId,
        }),
      });
      if (!res.ok) await throwSupportError(res, "support intake turn");
      const { data } = await res.json();
      return data;
    },
    onMutate: (vars) => {
      const said = vars.userMessage ?? vars.chosenLabel;
      if (!said) return {};
      const optimisticId = nextLocalId();
      setMessages((m) => [
        ...m,
        { id: optimisticId, sender: "USER", body: said, pending: true },
      ]);
      return { optimisticId };
    },
    onSuccess: (result, vars, context) => {
      if (vars.epoch !== sittingRef.current) return;
      setText("");
      setMessages((m) => [
        ...m.map((x) =>
          x.id === context?.optimisticId ? { ...x, pending: false } : x,
        ),
        ...result.messages.map((msg) => ({
          id: nextLocalId(),
          sender: msg.sender as Sender,
          body: msg.body,
          options: msg.metadata?.options ?? undefined,
        })),
      ]);
      if (result.nextNodeId) {
        setVisitedNodeIds((prev) =>
          prev.includes(result.nextNodeId!)
            ? prev
            : [...prev, result.nextNodeId!],
        );
      }
      setNodeId(result.nextNodeId);
      if (result.escalated) {
        setDone({
          resolved: false,
          ticketId: result.supportTicketId,
          ticketReference: result.supportTicketReference,
          replyByAt: result.replyByAt ?? null,
        });
        void qc.invalidateQueries({ queryKey: ["user-support-tickets"] });
      } else if (result.resolved) {
        setDone({
          resolved: true,
          outcomeId: result.outcomeId ?? null,
          collectFeedback: (result.actions ?? []).some(
            (a) => a.kind === "COLLECT_FEEDBACK",
          ),
        });
      }
    },
    onError: (e: unknown, _vars, context) => {
      if (context?.optimisticId) {
        setMessages((m) => m.filter((x) => x.id !== context.optimisticId));
      }
      toast({
        title: "Support",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const rateOutcome = async (rating: number) => {
    if (!done?.outcomeId) return;
    try {
      const res = await fetch(
        `/api/support/flow-outcomes/${done.outcomeId}/rating`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating }),
        },
      );
      if (res.ok) {
        setFlowRating(rating);
      }
    } catch {
      // Best-effort rating telemetry; never blocks the user.
    }
  };

  const startFlow = (flow: PlatformFlow) => {
    if (turn.isPending) return;
    sittingRef.current += 1;
    setFlowId(flow.id);
    setNodeId(null);
    setVisitedNodeIds([]);
    setMessages([]);
    setDone(null);
    setFlowRating(null);
    setBareHumanLabel(null);
    setBareHumanDetails("");
    setBareHumanUrgent(false);
    turn.mutate({
      flowId: flow.id,
      chosenLabel: flow.title,
      epoch: sittingRef.current,
    });
  };

  const reset = () => {
    sittingRef.current += 1;
    setFlowId(null);
    setNodeId(null);
    setVisitedNodeIds([]);
    setMessages([]);
    setDone(null);
    setFlowRating(null);
    setFeedback("");
    setBareHumanLabel(null);
    setBareHumanDetails("");
    setBareHumanUrgent(false);
  };

  // #705 — the "leave feedback" terminal used to say the entry was "read and
  // tracked" and then persist nothing at all. This is what makes that true; it
  // writes product Feedback, NOT a support ticket, because a suggestion is not
  // a support request and filing one would put every opinion in the ops queue.
  const sendFeedback = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch("/api/user/feedbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Product feedback from support",
          description: body,
          category: "SUPPORT_FLOW",
        }),
      });
      if (!res.ok) await throwSupportError(res, "feedback submit");
      return res.json();
    },
    onSuccess: () => {
      setFeedback("");
      setDone((d) => (d ? { ...d, collectFeedback: false } : d));
      toast({
        title: "Thanks — that's with the product team",
      });
    },
    onError: (e: unknown) => {
      toast({
        title: "Feedback",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const lastBot = [...messages].reverse().find((m) => m.sender === "BOT");
  const options = done ? [] : (lastBot?.options ?? []);

  // Keep the newest bubble in view — the transcript is a plain overflow
  // container, so past the drawer height every reply lands below the fold.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [open, messages.length, turn.isPending]);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        setOpen(v);
      }}
    >
      <SheetTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <LifeBuoy className="mr-1.5 h-4 w-4" />
            Get help
          </Button>
        )}
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="px-5 pb-3 pt-5">
          <SheetTitle>How can we help?</SheetTitle>
          <SheetDescription>
            {flowId
              ? "Pick an option, or type a message."
              : "Pick a topic, or browse the Help Center for quick answers."}
          </SheetDescription>
        </SheetHeader>

        {/* Bottom-aligned like the per-appointment drawer: a short transcript
            sits against the composer rather than at the top of an empty panel. */}
        <div className="flex-1 overflow-y-auto px-5 pb-2">
          <div className="flex min-h-full flex-col justify-end space-y-3">
            {!flowId &&
              (catalog.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : catalog.isError ? (
                <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                  {(catalog.error as Error)?.message ??
                    "Couldn't load support topics."}{" "}
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-1"
                    onClick={() => catalog.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {(catalog.data ?? []).map((f) => (
                    <Button
                      key={f.id}
                      variant="outline"
                      disabled={turn.isPending}
                      className="h-auto justify-start py-2 text-left"
                      onClick={() => startFlow(f)}
                    >
                      <span>
                        <span className="block text-sm font-medium">
                          {f.title}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {f.description}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              ))}

            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.sender === "USER"
                    ? "flex justify-end"
                    : "flex justify-start"
                }
              >
                {/* No per-bubble "USER"/"BOT" caption — side and colour say it. */}
                <div
                  className={
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm transition-opacity " +
                    (m.sender === "USER"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground") +
                    (m.pending ? " opacity-70" : "")
                  }
                >
                  {/* Screen-reader-only speaker attribution: the visual design
                      dropped the captions, and side plus colour say nothing to
                      assistive tech. */}
                  <span className="sr-only">
                    {m.sender === "USER" ? "You said" : "Assistant said"}:{" "}
                  </span>
                  {m.body}
                </div>
              </div>
            ))}

            {turn.isPending && (
              <div className="flex justify-start">
                <div
                  className="flex items-center gap-1 rounded-2xl bg-muted px-3 py-2.5"
                  role="status"
                  aria-label="Support is typing"
                >
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="h-1.5 w-1.5 rounded-full bg-foreground/40 motion-safe:animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {done?.resolved && !done.collectFeedback && (
              <div className="space-y-2">
                <Badge variant="secondary" className="mt-1">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Resolved
                </Badge>
                <div className="rounded-lg border border-border bg-card p-3 text-xs">
                  <p className="font-medium text-foreground">
                    {flowRating
                      ? "Thanks for rating this answer."
                      : "Was this answer helpful?"}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Button
                        key={star}
                        type="button"
                        size="sm"
                        variant={flowRating === star ? "default" : "outline"}
                        className="h-7 w-7 p-0 text-xs"
                        aria-label={`Rate ${star} out of 5`}
                        onClick={() => void rateOutcome(star)}
                      >
                        {star}★
                      </Button>
                    ))}
                  </div>
                  {flowRating !== null && flowRating <= 2 && (
                    <div className="mt-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setDone(null);
                          setBareHumanLabel(HUMAN_EXIT_LABEL);
                        }}
                      >
                        {HUMAN_EXIT_LABEL}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {done?.collectFeedback && (
              <div className="space-y-2">
                <Textarea
                  rows={4}
                  maxLength={2000}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="What would you change?"
                />
                <Button
                  size="sm"
                  disabled={!feedback.trim() || sendFeedback.isPending}
                  onClick={() => sendFeedback.mutate(feedback.trim())}
                >
                  Send to the product team
                </Button>
              </div>
            )}
            {done && !done.resolved && done.ticketId && (
              <div className="rounded-lg border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                <Ticket className="mr-1 inline h-3 w-3" />
                {done.ticketReference ? (
                  <>
                    Request{" "}
                    <span className="font-mono text-foreground">
                      {done.ticketReference}
                    </span>{" "}
                    created — quote it if you follow up.{" "}
                  </>
                ) : (
                  <>Ticket created — </>
                )}
                {describeWait(done.replyByAt)}
                {requestHref && (
                  <Link
                    href={requestHref(done.ticketId)}
                    className="ml-1 font-medium text-foreground underline underline-offset-4"
                  >
                    Open the request
                  </Link>
                )}
              </div>
            )}
            <div aria-live="polite" className="sr-only">
              {turn.isPending
                ? "Sending message…"
                : done && !done.resolved
                  ? "Request escalated to our support team."
                  : offline
                    ? "You are offline. Draft preserved."
                    : ""}
            </div>
            {offline && (
              <div
                role="alert"
                className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
              >
                You appear to be offline — your message draft is preserved here.
                If your connection does not come back, you can reach us at{" "}
                <Link
                  href="/contactus"
                  className="font-medium underline underline-offset-4"
                >
                  /contactus
                </Link>
                .
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        {flowId && !done && (
          <div className="space-y-3 border-t border-border px-5 pb-5 pt-4">
            {bareHumanLabel ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const details = bareHumanDetails.trim();
                  if (details.length < 20) return;
                  const targetNode = nodeId;
                  const urgent = bareHumanUrgent;
                  setBareHumanLabel(null);
                  setBareHumanDetails("");
                  setBareHumanUrgent(false);
                  turn.mutate({
                    flowId: flowId!,
                    nodeId: targetNode,
                    userMessage: `Speak to someone: ${details}`,
                    urgent,
                    epoch: sittingRef.current,
                  });
                }}
              >
                <Label htmlFor="platform-support-human-details">
                  Tell us what happened
                </Label>
                <Textarea
                  id="platform-support-human-details"
                  rows={4}
                  maxLength={1900}
                  value={bareHumanDetails}
                  onChange={(e) => setBareHumanDetails(e.target.value)}
                  disabled={turn.isPending}
                  placeholder="What went wrong, and what would you like us to do?"
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={bareHumanUrgent}
                    onChange={(e) => setBareHumanUrgent(e.target.checked)}
                    disabled={turn.isPending}
                  />
                  <span>This is urgent</span>
                </label>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setBareHumanLabel(null);
                      setBareHumanDetails("");
                      setBareHumanUrgent(false);
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      turn.isPending || bareHumanDetails.trim().length < 20
                    }
                  >
                    Send to the support team
                  </Button>
                </div>
              </form>
            ) : (
              <>
                {options.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {options.map((o) => (
                      <Button
                        key={o.id}
                        variant="outline"
                        size="sm"
                        disabled={turn.isPending}
                        onClick={() =>
                          // A flow's own human option opens the same details + urgency form as the exit.
                          o.label === HUMAN_EXIT_LABEL
                            ? setBareHumanLabel(o.label)
                            : turn.mutate({
                                flowId: flowId!,
                                nodeId,
                                chosenOptionId: o.id,
                                chosenLabel: o.label,
                                epoch: sittingRef.current,
                              })
                        }
                      >
                        {o.label}
                      </Button>
                    ))}
                  </div>
                )}
                {/* The human exit stays one tap away at every prompt, not only in the General flow. */}
                {options.every((o) => o.label !== HUMAN_EXIT_LABEL) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={turn.isPending}
                    onClick={() => setBareHumanLabel(HUMAN_EXIT_LABEL)}
                  >
                    {HUMAN_EXIT_LABEL}
                  </Button>
                )}
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const msg = text.trim();
                    if (!msg) return;
                    if (isBareHumanRequest(msg)) {
                      setText("");
                      setBareHumanLabel(msg);
                      return;
                    }
                    turn.mutate({
                      flowId: flowId!,
                      nodeId,
                      userMessage: msg,
                      epoch: sittingRef.current,
                    });
                  }}
                >
                  <Input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Type a message…"
                    disabled={turn.isPending}
                  />
                  <Button
                    type="submit"
                    size="icon"
                    disabled={turn.isPending || !text.trim()}
                    aria-label="Send"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
