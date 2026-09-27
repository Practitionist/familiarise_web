"use client";

import { Bot, Headset, Lock, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import { toneClass } from "@/lib/ui/tone";
import { cn } from "@/utils/tailwind";

export type BubbleAuthor = "USER" | "BOT" | "AGENT" | "SYSTEM";

/** Announced to assistive tech; side and colour carry it visually. */
function speakerLabel(author: BubbleAuthor, perspective: "staff" | "user") {
  if (author === "USER") {
    return perspective === "user" ? "You said" : "Customer said";
  }
  return author === "AGENT" ? "Support said" : "Assistant said";
}

const DEFAULT_NAME: Record<BubbleAuthor, string> = {
  USER: "Customer",
  AGENT: "Support",
  BOT: "Assistant",
  SYSTEM: "System",
};

const ICON = {
  USER: UserRound,
  AGENT: Headset,
  BOT: Bot,
  SYSTEM: Bot,
} as const;

/**
 * #1527 — one chat bubble for both sides of a support conversation. The
 * viewer's own messages sit on the right; a private note (staff only) is
 * dashed and labelled so it can never be mistaken for a reply.
 */
export function SupportBubble({
  author,
  authorName,
  body,
  at,
  internal = false,
  perspective,
  pending = false,
  footer,
}: Readonly<{
  author: BubbleAuthor;
  authorName?: string | null;
  body: string;
  at?: string;
  internal?: boolean;
  perspective: "staff" | "user";
  pending?: boolean;
  footer?: ReactNode;
}>) {
  if (author === "SYSTEM") {
    return (
      <p className="py-1 text-center text-xs text-muted-foreground">
        <span className="sr-only">System: </span>
        {body}
      </p>
    );
  }
  const own = perspective === "user" ? author === "USER" : author === "AGENT";
  const Icon = ICON[author];
  const time = at
    ? new Date(at).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  return (
    <div className={cn("flex", own ? "justify-end" : "justify-start")}>
      <div className="max-w-[85%] space-y-1">
        {(perspective === "staff" || !own) && (
          <p
            className={cn(
              "flex items-center gap-1 text-[11px] text-muted-foreground",
              own && "justify-end",
            )}
          >
            {internal ? (
              <Lock className="h-3 w-3" aria-hidden />
            ) : (
              <Icon className="h-3 w-3" aria-hidden />
            )}
            <span>
              {internal
                ? `Private note${authorName ? ` · ${authorName}` : ""}`
                : (authorName ?? DEFAULT_NAME[author])}
            </span>
            {time && <span aria-hidden>· {time}</span>}
          </p>
        )}
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm",
            internal && [
              "border border-dashed",
              toneClass("caution").className,
            ],
            !internal && own && "bg-primary text-primary-foreground",
            !internal &&
              !own &&
              author === "USER" &&
              "border border-border bg-card text-foreground",
            !internal &&
              !own &&
              author !== "USER" &&
              "bg-muted text-foreground",
            pending && "opacity-70",
          )}
        >
          <span className="sr-only">
            {internal
              ? "Private note: "
              : `${speakerLabel(author, perspective)}: `}
          </span>
          {body}
        </div>
        {footer}
      </div>
    </div>
  );
}
