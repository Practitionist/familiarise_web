"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, Send } from "lucide-react";

import { SupportBubble } from "@/components/support/SupportBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SavedReply } from "@/lib/support/saved-replies";
import type { ArticleLink, CaseWorkspace } from "@/types/support-case";
import { cn } from "@/utils/tailwind";

import { articleInsertText, CaseInsertMenu } from "./CaseInsertMenu";

export type ComposerMode = "reply" | "note";

const noteKey = (caseKey: string) => `support-note-draft:${caseKey}`;

function readNote(caseKey: string): string {
  try {
    return window.localStorage.getItem(noteKey(caseKey)) ?? "";
  } catch {
    return "";
  }
}

function writeNote(caseKey: string, value: string) {
  try {
    if (value) window.localStorage.setItem(noteKey(caseKey), value);
    else window.localStorage.removeItem(noteKey(caseKey));
  } catch {
    // Private mode or a full quota: the draft just isn't kept.
  }
}

const NOTE_HINT_ID = "support-note-hint";
const CLOSED_HINT_ID = "support-closed-hint";

/**
 * #1527 — the case timeline and its composer. Reply and Private note keep
 * separate drafts, so switching modes can never send a note's text to the
 * user; the note draft is kept per case in this browser (localStorage).
 * Saved replies and Help Center links come in through the Insert menu and
 * the suggestion chips, always into the reply.
 */
export function CaseConversation({
  data,
  mode,
  onModeChange,
  replyDraft,
  onReplyDraftChange,
  sending,
  onSend,
  replies,
  suggested,
  helpArticles,
  onInsert,
}: Readonly<{
  data: CaseWorkspace;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  replyDraft: string;
  onReplyDraftChange: (value: string) => void;
  sending: boolean;
  onSend: (message: string, note: boolean) => Promise<unknown>;
  replies: SavedReply[];
  suggested: ArticleLink[];
  helpArticles: ArticleLink[];
  onInsert: (text: string) => void;
}>) {
  const canNote = !!data.ticketId;
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);

  useEffect(() => {
    setNote(readNote(data.key));
    setNoteSaved(false);
  }, [data.key]);

  const changeNote = (value: string) => {
    setNote(value);
    writeNote(data.key, value);
    setNoteSaved(true);
  };

  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [data.key, data.timeline.length]);

  const isNote = mode === "note" && canNote;
  // A closed case refuses public replies server-side; private notes still land.
  const replyLocked = data.status === "CLOSED" && !isNote;
  const draft = isNote ? note : replyDraft;
  const submit = async () => {
    const message = draft.trim();
    if (!message || sending || replyLocked) return;
    try {
      await onSend(message, isNote);
    } catch {
      return; // the toast says why; the draft stays for a retry
    }
    if (isNote) changeNote("");
    else onReplyDraftChange("");
    setNoteSaved(false);
  };

  return (
    <div className="flex min-h-[28rem] flex-col rounded-lg border border-border bg-card">
      {data.handoffSummary && (
        <div className="border-b border-border bg-muted/40 px-4 py-3 text-xs">
          <p className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
            Case Summary
          </p>
          <p className="whitespace-pre-line text-foreground">
            {data.handoffSummary}
          </p>
        </div>
      )}
      <div className="max-h-[60vh] flex-1 space-y-3 overflow-y-auto p-4">
        {data.timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          data.timeline.map((m) => (
            <SupportBubble
              key={m.id}
              perspective="staff"
              author={m.author}
              authorName={m.authorName}
              body={m.body}
              at={m.at}
              internal={m.internal}
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="space-y-2 border-t border-border p-3">
        {suggested.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Suggested:</span>
            {suggested.slice(0, 3).map((a) => (
              <button
                key={a.href}
                type="button"
                title="Insert a link to this article"
                onClick={() => onInsert(articleInsertText(a))}
                className="max-w-[16rem] truncate rounded-full border border-border px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
              >
                {a.title}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="tablist"
            aria-label="Composer mode"
            className="flex items-center gap-1"
          >
            {(["reply", "note"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                disabled={m === "note" && !canNote}
                aria-describedby={
                  m === "note" && !canNote ? NOTE_HINT_ID : undefined
                }
                title={
                  m === "note" && !canNote
                    ? "Private notes need a ticket; this conversation has not been escalated."
                    : undefined
                }
                onClick={() => onModeChange(m)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                  mode === m
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "note" && <Lock className="h-3 w-3" aria-hidden />}
                {m === "reply" ? "Reply" : "Private note"}
              </button>
            ))}
            {!canNote && (
              <span
                id={NOTE_HINT_ID}
                className="text-[11px] text-muted-foreground"
              >
                Needs a ticket
              </span>
            )}
          </div>
          <CaseInsertMenu
            replies={replies}
            suggested={suggested}
            all={helpArticles}
            onInsert={onInsert}
          />
        </div>
        {replyLocked && (
          <p
            id={CLOSED_HINT_ID}
            className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {canNote
              ? "This request is closed, so the customer can't receive replies. Private notes are still allowed."
              : "This conversation is closed, so the customer can't receive replies."}
          </p>
        )}
        <Textarea
          aria-label={isNote ? "Private note" : "Reply to the customer"}
          aria-describedby={replyLocked ? CLOSED_HINT_ID : undefined}
          disabled={replyLocked}
          rows={3}
          value={draft}
          placeholder={
            isNote
              ? "Only staff see this. It is never sent to the customer."
              : "Write a reply the customer will see…"
          }
          onChange={(e) => {
            if (isNote) changeNote(e.target.value);
            else onReplyDraftChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          className={cn(isNote && "border-dashed")}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {isNote &&
              (noteSaved && note
                ? "Draft saved on this device."
                : "Note drafts are saved on this device.")}
          </p>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={sending || replyLocked || !draft.trim()}
          >
            {isNote ? (
              <Lock className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            ) : (
              <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            {isNote ? "Add note" : "Send reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}
