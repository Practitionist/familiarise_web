"use client";

import { useState, type FormEvent } from "react";
import { Send, Tv2, X } from "lucide-react";
import {
  MAX_STAGE_QUESTION_LENGTH,
  type StagePinnedBanner,
  type StageQuestion,
} from "@/lib/meetings/stage-qa";
import { cn } from "@/utils/tailwind";

interface StageQaDrawerProps {
  questions: StageQuestion[];
  activeBanner: StagePinnedBanner | null;
  isHost: boolean;
  onAskQuestion: (text: string) => Promise<void>;
  onPinQuestion: (question: StageQuestion) => Promise<void>;
  onUnpinQuestion: () => Promise<void>;
  isSubmitting: boolean;
}

export function StageQaDrawer({
  questions,
  activeBanner,
  isHost,
  onAskQuestion,
  onPinQuestion,
  onUnpinQuestion,
  isSubmitting,
}: StageQaDrawerProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || isSubmitting) return;
    setError(null);
    try {
      await onAskQuestion(trimmed);
      setDraft("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not send question right now.",
      );
    }
  };

  return (
    <div
      data-testid="stage-qa-drawer"
      className="flex h-[calc(100%-60px)] flex-col justify-between"
    >
      <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {questions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <Tv2 className="mb-2 h-8 w-8 text-zinc-600" />
            <p className="text-sm font-medium text-zinc-300">No questions yet</p>
            <p className="mt-1 text-xs text-zinc-500">
              {isHost
                ? "Questions from participants appear here. Click Show on Screen to spotlight any question over the live video stage."
                : "Ask a question below. The host can spotlight questions live on screen."}
            </p>
          </div>
        ) : (
          questions.map((q) => {
            const isPinned = activeBanner?.questionId === q.id;
            return (
              <div
                key={q.id}
                className={cn(
                  "rounded-xl border p-3 transition-colors",
                  isPinned
                    ? "border-amber-500/50 bg-amber-500/10"
                    : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-zinc-200">
                      {q.authorName}
                    </span>
                    {q.authorRole === "host" && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                        Host
                      </span>
                    )}
                    {isPinned && (
                      <span className="rounded border border-amber-400/40 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-300 uppercase">
                        ON SCREEN
                      </span>
                    )}
                  </div>
                </div>

                <p className="mt-1.5 break-words text-sm text-zinc-100">
                  {q.text}
                </p>

                {isHost && (
                  <div className="mt-2.5 flex items-center justify-end">
                    {isPinned ? (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={onUnpinQuestion}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" />
                        Hide from screen
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => onPinQuestion(q)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:border-amber-500/50 hover:bg-amber-500/15 hover:text-amber-200 disabled:opacity-50"
                      >
                        <Tv2 className="h-3 w-3" />
                        Show on screen
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-800 bg-zinc-950/60 p-3"
      >
        {error && <p className="mb-1.5 text-xs text-red-400">{error}</p>}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_STAGE_QUESTION_LENGTH}
            placeholder="Ask a question..."
            className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-zinc-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || isSubmitting}
            title="Send question"
            className="rounded-xl bg-white p-2.5 text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
