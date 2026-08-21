"use client";

/**
 * #appt-support — the per-appointment "Get help" surface. A Sheet drawer that
 * drives the channel-agnostic support thread: it renders the flowchart bot's
 * prompts as tap-able options, lets the user type free text, and shows the
 * hand-off state once a turn escalates to a human. It only ever DISPLAYS the
 * actions a resolver requests (e.g. an eligible refund %) — execution is a
 * separate server-validated surface, never fired from here.
 */

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, LifeBuoy, Send, UserRound, Bot } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

type Sender = "USER" | "BOT" | "AGENT" | "SYSTEM";

interface ThreadMessage {
  id: string;
  sender: Sender;
  body: string;
  metadata?: { options?: { id: string; label: string }[] } | null;
  createdAt: string;
}

interface SupportThread {
  id: string;
  status: string;
  activeChannel: string;
  currentNodeId: string | null;
  messages: ThreadMessage[];
}

type SupportAction =
  | { kind: "OFFER_CANCEL_REFUND"; refundPct: number }
  | { kind: string };

interface TurnResult {
  status: string;
  activeChannel: string;
  escalated: boolean;
  resolved: boolean;
  actions: SupportAction[];
}

/** The entry intents. SPONSORSHIP_BILLING is offered only in an org context; the
 *  server is the source of truth (an unavailable intent falls back to a human).
 *  #support-hub: the GET now returns the server-gated intent list (stage /
 *  provider / org-operator aware) — this static list is only the fallback. */
const INTENTS: { category: string; label: string; orgOnly?: boolean }[] = [
  { category: "CANCEL_REFUND", label: "Cancel & refund" },
  { category: "RESCHEDULE", label: "Reschedule" },
  { category: "NO_SHOW", label: "The other party didn't show" },
  { category: "PAYMENT_STATUS", label: "Payment or refund status" },
  { category: "RECORDING_ACCESS", label: "Recording access" },
  { category: "QUALITY_COMPLAINT", label: "Session quality" },
  { category: "TECHNICAL", label: "Technical trouble" },
  { category: "SPONSORSHIP_BILLING", label: "Sponsorship & billing", orgOnly: true },
  { category: "ORG_ADMIN_DISPUTE", label: "Raise a concern" },
  { category: "OTHER", label: "Something else" },
];

function describeAction(a: SupportAction): string | null {
  if (a.kind === "OFFER_CANCEL_REFUND") {
    const pct = "refundPct" in a ? a.refundPct : 0;
    return pct > 0
      ? `You're eligible for a ${pct}% refund if you cancel now.`
      : "Cancelling now is outside the refund window — no refund would apply.";
  }
  if (a.kind === "SHOW_INVOICES") {
    return "Invoices and GST receipts live on your Payments page.";
  }
  return null;
}

export function SupportThreadSheet({
  appointmentId,
  isOrgContext = false,
  open: controlledOpen,
  onOpenChange,
  trigger,
  appointmentHref,
}: {
  appointmentId: string;
  isOrgContext?: boolean;
  /** Controlled open state — when set, the sheet renders no default trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Custom trigger node (ignored when `open` is controlled). */
  trigger?: React.ReactNode;
  /** When provided, the header carries a "Go to appointment" link. Deliberately
   *  omitted on org surfaces (ADR 20: no per-session drill-in for org roles). */
  appointmentHref?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    onOpenChange?.(v);
    if (controlledOpen === undefined) setInternalOpen(v);
  };
  const [text, setText] = useState("");
  const [lastActions, setLastActions] = useState<SupportAction[]>([]);
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = ["support-thread", appointmentId] as const;

  const {
    data,
    isFetching,
  } = useQuery({
    queryKey,
    enabled: open,
    queryFn: async (): Promise<{
      thread: SupportThread | null;
      intents: { category: string; title: string }[];
    }> => {
      const res = await fetch(`/api/appointments/${appointmentId}/support`);
      if (!res.ok) throw new Error("Failed to load support");
      const json = await res.json();
      return { thread: json.data, intents: json.intents ?? [] };
    },
  });
  const thread = data?.thread ?? null;

  // Server-gated intents win; fall back to the static list filtered by org.
  const availableIntents =
    data?.intents && data.intents.length > 0
      ? data.intents.map((i) => ({ category: i.category, label: i.title }))
      : INTENTS.filter((i) => !i.orgOnly || isOrgContext).map((i) => ({
          category: i.category,
          label: i.label,
        }));

  const turn = useMutation({
    mutationFn: async (body: {
      category?: string;
      chosenOptionId?: string;
      userMessage?: string;
    }): Promise<TurnResult> => {
      const res = await fetch(`/api/appointments/${appointmentId}/support`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? "Something went wrong");
      }
      const { data } = await res.json();
      return data;
    },
    onSuccess: (result) => {
      setLastActions(result.actions ?? []);
      setText("");
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: unknown) => {
      toast({
        title: "Support",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const messages = thread?.messages ?? [];
  const isHuman = thread?.activeChannel === "HUMAN";
  const isResolved = thread?.status === "RESOLVED";
  const lastBot = [...messages].reverse().find((m) => m.sender === "BOT");
  const options = !isHuman && !isResolved ? (lastBot?.metadata?.options ?? []) : [];
  const started = !!thread;
  // A press must stay dead until the server state has round-tripped: the
  // double-bubble bug was a second POST landing in the refetch window after
  // isPending flipped false but before the refetch swapped the options.
  const turnPending = turn.isPending || (turn.isSuccess && isFetching);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
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
          <div className="flex items-start justify-between gap-2 pr-6">
            <SheetTitle>Help with this session</SheetTitle>
            {appointmentHref && (
              <Button variant="outline" size="sm" asChild className="shrink-0">
                <Link href={appointmentHref}>
                  <CalendarDays className="mr-1.5 h-4 w-4" />
                  Go to appointment
                </Link>
              </Button>
            )}
          </div>
          <SheetDescription>
            {isHuman
              ? "You're connected with our support team — they'll reply here."
              : "Pick what you need help with, or type a message."}
          </SheetDescription>
        </SheetHeader>

        {/* Conversation */}
        <div className="flex-1 space-y-3 overflow-y-auto px-5 pb-2">
          {!started && (
            <p className="text-sm text-muted-foreground">
              What do you need help with?
            </p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={
                m.sender === "USER" ? "flex justify-end" : "flex justify-start"
              }
            >
              <div
                className={
                  "max-w-[85%] rounded-2xl px-3 py-2 text-sm " +
                  (m.sender === "USER"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground")
                }
              >
                <span className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-60">
                  {m.sender === "USER" ? (
                    <UserRound className="h-3 w-3" />
                  ) : (
                    <Bot className="h-3 w-3" />
                  )}
                  {m.sender === "AGENT" ? "Support" : m.sender.toLowerCase()}
                </span>
                {m.body}
              </div>
            </div>
          ))}

          {/* Offered actions from the latest turn (informational, not executed) */}
          {lastActions.map(describeAction).map((desc, i) =>
            desc ? (
              <div
                key={i}
                className="rounded-lg border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground"
              >
                {desc}
              </div>
            ) : null,
          )}

          {isResolved && (
            <Badge variant="secondary" className="mt-1">
              Resolved
            </Badge>
          )}
        </div>

        {/* Controls */}
        <div className="space-y-3 border-t border-border px-5 pb-5 pt-4">
          {!started ? (
            <div className="flex flex-wrap gap-2">
              {availableIntents.map((i) => (
                <Button
                  key={i.category}
                  variant="outline"
                  size="sm"
                  disabled={turnPending}
                  onClick={() => turn.mutate({ category: i.category })}
                >
                  {i.label}
                </Button>
              ))}
            </div>
          ) : (
            options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {options.map((o) => (
                  <Button
                    key={o.id}
                    variant="outline"
                    size="sm"
                    disabled={turnPending}
                    onClick={() => turn.mutate({ chosenOptionId: o.id })}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            )
          )}

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const msg = text.trim();
              if (msg) turn.mutate({ userMessage: msg });
            }}
          >
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={isHuman ? "Message support…" : "Type a message…"}
              disabled={turnPending}
            />
            <Button
              type="submit"
              size="icon"
              disabled={turnPending || !text.trim()}
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
