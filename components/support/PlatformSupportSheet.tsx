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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, Send, UserRound, Bot, CheckCircle2, Ticket } from "lucide-react";
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

interface LocalMessage {
  sender: Sender;
  body: string;
  options?: { id: string; label: string }[];
}

interface PlatformFlow {
  id: string;
  title: string;
  description: string;
}

interface TurnResponse {
  messages: { sender: string; body: string }[];
  nextNodeId: string | null;
  resolved: boolean;
  escalated: boolean;
  supportTicketId?: string;
}

export function PlatformSupportSheet({
  open: controlledOpen,
  onOpenChange,
  trigger,
  orgId,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  /** Active org for operator flows (attribution, server-validated). */
  orgId?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    onOpenChange?.(v);
    if (controlledOpen === undefined) setInternalOpen(v);
  };
  const [text, setText] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [done, setDone] = useState<{ resolved: boolean; ticketId?: string } | null>(
    null,
  );
  const { toast } = useToast();
  const qc = useQueryClient();

  const catalog = useQuery({
    queryKey: ["platform-support-intents"],
    enabled: open,
    queryFn: async (): Promise<PlatformFlow[]> => {
      const res = await fetch("/api/support/platform");
      if (!res.ok) throw new Error("Failed to load support topics");
      const { data } = await res.json();
      return data.flows;
    },
  });

  const turn = useMutation({
    mutationFn: async (body: {
      flowId: string;
      nodeId?: string | null;
      chosenOptionId?: string;
      userMessage?: string;
    }): Promise<TurnResponse> => {
      const res = await fetch("/api/support/platform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, orgId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? "Something went wrong");
      }
      const { data } = await res.json();
      return data;
    },
    onSuccess: (result, vars) => {
      setText("");
      setMessages((m) => [
        ...m,
        ...(vars.userMessage ? [{ sender: "USER" as const, body: vars.userMessage }] : []),
        ...result.messages.map((m) => ({ sender: m.sender as Sender, body: m.body })),
      ]);
      setNodeId(result.nextNodeId);
      if (result.escalated) {
        setDone({ resolved: false, ticketId: result.supportTicketId });
        void qc.invalidateQueries({ queryKey: ["user-support-tickets"] });
      } else if (result.resolved) {
        setDone({ resolved: true });
      }
    },
    onError: (e: unknown) => {
      toast({
        title: "Support",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const startFlow = (flow: PlatformFlow) => {
    setFlowId(flow.id);
    setNodeId(null);
    setMessages([]);
    setDone(null);
    turn.mutate({ flowId: flow.id });
  };

  const reset = () => {
    setFlowId(null);
    setNodeId(null);
    setMessages([]);
    setDone(null);
  };

  const lastBot = [...messages].reverse().find((m) => m.sender === "BOT");
  const options = done ? [] : (lastBot?.options ?? []);

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
        <SheetHeader>
          <SheetTitle>How can we help?</SheetTitle>
          <SheetDescription>
            {flowId
              ? "Pick an option, or type a message."
              : "Pick a topic, or browse the Help section for quick answers."}
          </SheetDescription>
        </SheetHeader>

        <div className="my-4 flex-1 space-y-3 overflow-y-auto pr-1">
          {!flowId &&
            (catalog.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <div className="flex flex-col gap-2">
                {(catalog.data ?? []).map((f) => (
                  <Button
                    key={f.id}
                    variant="outline"
                    className="h-auto justify-start py-2 text-left"
                    onClick={() => startFlow(f)}
                  >
                    <span>
                      <span className="block text-sm font-medium">{f.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {f.description}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            ))}

          {messages.map((m, i) => (
            <div
              key={i}
              className={m.sender === "USER" ? "flex justify-end" : "flex justify-start"}
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
                  {m.sender.toLowerCase()}
                </span>
                {m.body}
              </div>
            </div>
          ))}

          {done?.resolved && (
            <Badge variant="secondary" className="mt-1">
              <CheckCircle2 className="mr-1 h-3 w-3" /> Resolved
            </Badge>
          )}
          {done && !done.resolved && done.ticketId && (
            <div className="rounded-lg border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground">
              <Ticket className="mr-1 inline h-3 w-3" />
              Ticket created — our team will reply here in &quot;My requests&quot;
              and by email.
            </div>
          )}
        </div>

        {flowId && !done && (
          <div className="space-y-3 border-t border-border pt-3">
            {options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {options.map((o) => (
                  <Button
                    key={o.id}
                    variant="outline"
                    size="sm"
                    disabled={turn.isPending}
                    onClick={() =>
                      turn.mutate({ flowId: flowId!, nodeId, chosenOptionId: o.id })
                    }
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            )}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const msg = text.trim();
                if (msg) turn.mutate({ flowId: flowId!, nodeId, userMessage: msg });
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
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
