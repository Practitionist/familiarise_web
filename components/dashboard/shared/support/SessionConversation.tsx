"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";

import { SupportBubble } from "@/components/support/SupportBubble";
import {
  describeAction,
  type useSupportThread,
} from "@/components/support/useSupportThread";
import { isBareHumanRequest } from "@/lib/support/escalation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ThreadState = ReturnType<typeof useSupportThread>;
type Option = {
  id: string;
  label: string;
  escalates?: boolean;
  isCategory?: boolean;
};

/** Enough for staff to act on without a round trip back to the user. */
const MIN_DESCRIPTION = 20;

function Handoff() {
  return (
    <div className="flex items-center gap-2">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] text-muted-foreground">
        Passed to our support team
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function OptionButtons({
  options,
  disabled,
  onPick,
}: Readonly<{
  options: Option[];
  disabled: boolean;
  onPick: (option: Option) => void;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Button
          key={o.id}
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onPick(o)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * Escalating options and bare human asks collect the problem description before
 * opening a staff ticket.
 */
function EscalateStep({
  option,
  disabled,
  onSend,
  onBack,
}: Readonly<{
  option: Option;
  disabled: boolean;
  onSend: (description: string, urgent: boolean) => void;
  onBack: () => void;
}>) {
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const short = text.trim().length < MIN_DESCRIPTION;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!short) onSend(text.trim(), urgent);
      }}
    >
      <p className="text-sm">
        <span className="text-muted-foreground">You chose: </span>
        {option.label}
      </p>
      <Label htmlFor="support-escalate-description">
        Tell us what happened
      </Label>
      <Textarea
        id="support-escalate-description"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
        rows={4}
        required
        disabled={disabled}
        placeholder="What went wrong, and what would you like us to do?"
      />
      <p className="text-[11px] text-muted-foreground">
        At least {MIN_DESCRIPTION} characters. Our support team will read this
        and reply here and by email.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={urgent}
          onChange={(e) => setUrgent(e.target.checked)}
          disabled={disabled}
        />
        <span>This is urgent</span>
      </label>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" size="sm" disabled={disabled || short}>
          Send to the support team
        </Button>
      </div>
    </form>
  );
}

export function SessionConversation({
  t,
  requestsHref = "/dashboard/support",
}: Readonly<{ t: ThreadState; requestsHref?: string }>) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Option | null>(null);
  const [offline, setOffline] = useState(false);
  const [flowRating, setFlowRating] = useState<number | null>(null);

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

  const rateFlow = async (rating: number) => {
    if (!t.lastOutcomeId) return;
    try {
      const res = await fetch(
        `/api/support/flow-outcomes/${t.lastOutcomeId}/rating`,
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
      // Best-effort rating telemetry.
    }
  };

  const escalating =
    picked && (picked.isCategory || t.options.some((o) => o.id === picked.id))
      ? picked
      : null;
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [t.messages.length, t.turnPending]);

  const intro = t.isHuman
    ? "You're connected with our support team. They'll reply here and by email."
    : "Pick what you need help with, or type a message.";

  const renderEscalateStep = (target: Option) => (
    <EscalateStep
      option={target}
      disabled={t.turnPending}
      onBack={() => setPicked(null)}
      onSend={(description, urgent) => {
        const sent = target.isCategory
          ? t.submitTurn({
              category: target.id,
              chosenLabel: target.label,
              userMessage: description,
              urgent,
            })
          : t.submitTurn({
              chosenOptionId: target.id,
              chosenLabel: target.label,
              userMessage: description,
              urgent,
            });
        if (sent) setPicked(null);
      }}
    />
  );

  // The human exit stays one tap away in every bot state, not only on the first menu.
  const humanIntent = t.availableIntents.find((i) => i.category === "OTHER");
  const humanExit =
    humanIntent && !t.isHuman && !t.isClosed ? humanIntent : null;

  const controls = () => {
    if (escalating) {
      return renderEscalateStep(escalating);
    }
    if (t.started) {
      return (
        <>
          {t.options.length > 0 && (
            <OptionButtons
              options={t.options}
              disabled={t.turnPending}
              onPick={(o) =>
                o.escalates
                  ? setPicked(o)
                  : t.submitTurn({ chosenOptionId: o.id, chosenLabel: o.label })
              }
            />
          )}
          {humanExit && (
            <Button
              variant="ghost"
              size="sm"
              disabled={t.turnPending}
              onClick={() =>
                setPicked({
                  id: humanExit.category,
                  label: humanExit.label,
                  escalates: true,
                  isCategory: true,
                })
              }
            >
              {humanExit.label}
            </Button>
          )}
        </>
      );
    }
    if (t.query.isError) {
      return (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load the help options for this session.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void t.query.refetch()}
          >
            Retry
          </Button>
        </div>
      );
    }
    if (t.availableIntents.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          {t.query.isFetching
            ? "Loading…"
            : "There are no help options for this session right now."}
        </p>
      );
    }
    return (
      <OptionButtons
        options={t.availableIntents.map((i) => ({
          id: i.category,
          label: i.label,
          escalates: i.escalates,
          isCategory: true,
        }))}
        disabled={t.turnPending}
        onPick={(o) =>
          o.escalates
            ? setPicked(o)
            : t.submitTurn({ category: o.id, chosenLabel: o.label })
        }
      />
    );
  };

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card">
      <div className="max-h-[60vh] min-h-[16rem] space-y-3 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">{intro}</p>
        {t.messages.map((m, i) => (
          <div key={m.id} className="space-y-3">
            {i === t.handoffIndex && <Handoff />}
            <SupportBubble
              perspective="user"
              author={m.sender}
              body={m.body}
              at={m.pending ? undefined : m.createdAt}
              pending={m.pending}
            />
          </div>
        ))}
        {t.isHuman && !t.isResolved && !t.isClosed && (
          <p className="text-center text-[11px] text-muted-foreground">
            {t.waitingLine}
          </p>
        )}
        {Object.entries(t.failedTurns).map(([id, f]) => (
          <SupportBubble
            key={id}
            perspective="user"
            author="USER"
            body={f.body}
            pending
            footer={
              <p className="flex items-center justify-end gap-2 text-[11px] text-destructive">
                <span>Not sent</span>
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => t.retryTurn(id)}
                >
                  Retry
                </button>
              </p>
            }
          />
        ))}
        {t.handoffIndex === t.messages.length && <Handoff />}
        {t.turnPending && !t.isHuman && (
          <output
            className="flex w-fit items-center gap-1 rounded-2xl bg-muted px-3 py-2.5"
            aria-label="Support is typing"
          >
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="h-1.5 w-1.5 rounded-full bg-foreground/40 motion-safe:animate-bounce"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </output>
        )}
        {t.lastActions.map(describeAction).map((desc, i) =>
          desc ? (
            <div
              key={`${i}-${desc}`}
              className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
            >
              {desc}
            </div>
          ) : null,
        )}
        {t.isResolved && !t.isHuman && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <p className="font-medium text-foreground">
              {flowRating
                ? "Thanks for rating this answer."
                : "Was this self-serve answer helpful?"}
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
                  onClick={() => void rateFlow(star)}
                >
                  {star}★
                </Button>
              ))}
            </div>
            {flowRating !== null && flowRating <= 2 && humanIntent && (
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setPicked({
                      id: humanIntent.category,
                      label: humanIntent.label,
                      escalates: true,
                      isCategory: true,
                    })
                  }
                >
                  {humanIntent.label}
                </Button>
              </div>
            )}
          </div>
        )}
        <div aria-live="polite" className="sr-only">
          {t.turnPending
            ? "Sending your message…"
            : t.isHuman
              ? t.waitingLine
              : offline
                ? "You are offline. Your draft message is preserved."
                : ""}
        </div>
        {offline && (
          <div
            role="alert"
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
          >
            You appear to be offline — your message draft is safe here. If you
            cannot reconnect right now, you can reach us at{" "}
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

      <div className="space-y-3 border-t border-border p-4">
        {controls()}
        {!escalating &&
          (t.isClosed ? (
            <p className="text-sm text-muted-foreground">
              This conversation is closed.{" "}
              <Link
                href={requestsHref}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Start a new request
              </Link>{" "}
              if you still need help.
            </p>
          ) : (
            <>
              {t.isHuman && t.isResolved && (
                <p className="text-xs text-muted-foreground">
                  This request is marked resolved. Replying reopens it.
                </p>
              )}
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const msg = text.trim();
                  if (!msg) return;
                  if (!t.isHuman && isBareHumanRequest(msg)) {
                    setText("");
                    setPicked({
                      id: "OTHER",
                      label: msg,
                      escalates: true,
                      isCategory: true,
                    });
                    return;
                  }
                  if (t.submitTurn({ userMessage: msg })) setText("");
                }}
              >
                <Input
                  aria-label="Message"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    t.isHuman ? "Message our team…" : "Type a message…"
                  }
                  disabled={t.turnPending}
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={t.turnPending || !text.trim()}
                  aria-label="Send"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </>
          ))}
      </div>
    </div>
  );
}
