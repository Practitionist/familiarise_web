"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";

import { SupportBubble } from "@/components/support/SupportBubble";
import {
  describeAction,
  type useSupportThread,
} from "@/components/support/useSupportThread";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ThreadState = ReturnType<typeof useSupportThread>;

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
  options: { id: string; label: string }[];
  disabled: boolean;
  onPick: (option: { id: string; label: string }) => void;
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
 * #1527 — the session conversation on the request page: the guided flow's
 * steps inline (options at the server's cursor), free text, and the hand-off
 * to our team, with the behaviour the old "Get help" drawer had.
 */
export function SessionConversation({ t }: Readonly<{ t: ThreadState }>) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [t.messages.length, t.turnPending]);

  const intro = t.isHuman
    ? "You're connected with our support team. They'll reply here and by email."
    : "Pick what you need help with, or type a message.";

  const controls = () => {
    if (t.started) {
      return (
        t.options.length > 0 && (
          <OptionButtons
            options={t.options}
            disabled={t.turnPending}
            onPick={(o) =>
              t.submitTurn({ chosenOptionId: o.id, chosenLabel: o.label })
            }
          />
        )
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
        }))}
        disabled={t.turnPending}
        onPick={(o) => t.submitTurn({ category: o.id, chosenLabel: o.label })}
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
        {/* Only while the flow is answering: an asynchronous hand-off has
            nobody typing, and dots promising a reply lose people. */}
        {t.turnPending && !t.isHuman && (
          <div
            className="flex w-fit items-center gap-1 rounded-2xl bg-muted px-3 py-2.5"
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
        <div ref={endRef} />
      </div>

      <div className="space-y-3 border-t border-border p-4">
        {controls()}
        {t.isClosed ? (
          <p className="text-sm text-muted-foreground">
            This conversation is closed. Start a new request from Support if you
            still need help.
          </p>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const msg = text.trim();
              if (msg && t.submitTurn({ userMessage: msg })) setText("");
            }}
          >
            <Input
              aria-label="Message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.isHuman ? "Message our team…" : "Type a message…"}
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
        )}
      </div>
    </div>
  );
}
