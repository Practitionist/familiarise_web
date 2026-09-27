"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, Send } from "lucide-react";

import { SupportBubble } from "@/components/support/SupportBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { CaseWorkspace } from "@/types/support-case";
import { cn } from "@/utils/tailwind";

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

/**
 * #1527 — the case timeline and its composer. Reply and Private note keep
 * separate drafts, so switching modes can never send a note's text to the
 * user; the note draft is kept per case in this browser (localStorage).
 */
export function CaseConversation({
  data,
  mode,
  onModeChange,
  replyDraft,
  onReplyDraftChange,
  sending,
  onSend,
}: Readonly<{
  data: CaseWorkspace;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  replyDraft: string;
  onReplyDraftChange: (value: string) => void;
  sending: boolean;
  onSend: (message: string, note: boolean) => Promise<unknown>;
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
  const draft = isNote ? note : replyDraft;
  const submit = async () => {
    const message = draft.trim();
    if (!message || sending) return;
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
        <div role="tablist" aria-label="Composer mode" className="flex gap-1">
          {(["reply", "note"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              disabled={m === "note" && !canNote}
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
        </div>
        <Textarea
          aria-label={isNote ? "Private note" : "Reply to the customer"}
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
            {!isNote &&
              !canNote &&
              "Private notes need a ticket; this conversation has not been escalated."}
          </p>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={sending || !draft.trim()}
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
