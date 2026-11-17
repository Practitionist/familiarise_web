"use client";

import { Bot, Headset, Lock, Presentation, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import { useZoneClock } from "@/lib/time/use-zone-clock";
import { toneClass } from "@/lib/ui/tone";
import { cn } from "@/utils/tailwind";

export type BubbleAuthor = "USER" | "BOT" | "AGENT" | "SYSTEM";

/** Announced to assistive tech; side and colour carry it visually. */
function speakerLabel(
  author: BubbleAuthor,
  perspective: "staff" | "user",
  presenter: boolean,
) {
  if (author === "USER") {
    return perspective === "user" ? "You said" : "Customer said";
  }
  if (presenter) return "Presenter said";
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

/** Bubble background/border, kept out of the component to hold cognitive
 * complexity down (#1527, Sonar S3776). */
function bubbleToneClass(
  internal: boolean,
  own: boolean,
  author: BubbleAuthor,
) {
  if (internal) return ["border border-dashed", toneClass("caution").className];
  if (own) return "bg-primary text-primary-foreground";
  if (author === "USER") return "border border-border bg-card text-foreground";
  return "bg-muted text-foreground";
}

function isOwnMessage(
  author: BubbleAuthor,
  perspective: "staff" | "user",
  presenter: boolean,
) {
  if (perspective === "user") return author === "USER";
  return author === "AGENT" && !presenter;
}

function senderNameFor(
  author: BubbleAuthor,
  authorName: string | null | undefined,
  internal: boolean,
  presenter: boolean,
) {
  if (internal) {
    return authorName ? `Private note · ${authorName}` : "Private note";
  }
  if (!presenter) return authorName ?? DEFAULT_NAME[author];
  return authorName ? `${authorName} · Presenter` : "Presenter";
}

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
  actorKind,
  perspective,
  pending = false,
  footer,
}: Readonly<{
  author: BubbleAuthor;
  authorName?: string | null;
  body: string;
  at?: string;
  internal?: boolean;
  /** A presenter reply is provider content, never Familiarise support. */
  actorKind?: "PRESENTER";
  perspective: "staff" | "user";
  pending?: boolean;
  footer?: ReactNode;
}>) {
  // IST in the back office, the viewer's zone on a customer page (the nearest DisplayZoneProvider).
  const clock = useZoneClock();
  if (author === "SYSTEM") {
    return (
      <p className="py-1 text-center text-xs text-muted-foreground">
        <span className="sr-only">System: </span>
        {body}
      </p>
    );
  }
  const presenter = actorKind === "PRESENTER";
  const own = isOwnMessage(author, perspective, presenter);
  const Icon = presenter ? Presentation : ICON[author];
  const time = at ? clock.dateTime(at) : null;
  const senderName = senderNameFor(author, authorName, internal, presenter);
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
            <span>{senderName}</span>
            {time && at && (
              <span aria-hidden>
                ·{" "}
                <time dateTime={at} title={clock.exactTitle(at) ?? undefined}>
                  {time}
                </time>
              </span>
            )}
          </p>
        )}
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm",
            bubbleToneClass(internal, own, author),
            pending && "opacity-70",
          )}
        >
          <span className="sr-only">
            {internal
              ? "Private note: "
              : `${speakerLabel(author, perspective, presenter)}: `}
          </span>
          {body}
        </div>
        {footer}
      </div>
    </div>
  );
}
