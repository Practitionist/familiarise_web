"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  CornerDownRight,
  RotateCcw,
  Send,
  ThumbsUp,
  Tv2,
  X,
} from "lucide-react";
import {
  MAX_STAGE_ANSWER_LENGTH,
  MAX_STAGE_QUESTION_LENGTH,
  type StagePinnedBanner,
  type StageQuestion,
} from "@/lib/meetings/stage-qa";
import { cn } from "@/utils/tailwind";

interface StageQaDrawerProps {
  questions: StageQuestion[];
  activeBanner: StagePinnedBanner | null;
  isHost: boolean;
  currentUserId?: string;
  onAskQuestion: (text: string) => Promise<boolean>;
  onToggleUpvote: (questionId: string) => Promise<void>;
  onAnswerQuestion: (
    questionId: string,
    answerText?: string,
  ) => Promise<boolean>;
  onReopenQuestion: (questionId: string) => Promise<void>;
  onPinQuestion: (question: StageQuestion) => Promise<void>;
  onUnpinQuestion: () => Promise<void>;
  isSubmitting: boolean;
  error?: string | null;
}

type QaFilter = "all" | "open" | "answered";
type QaSort = "popular" | "recent";

function getQuestionCardClasses(
  isPinned: boolean,
  isAnswered: boolean,
): string {
  if (isPinned) return "border-amber-500/50 bg-amber-500/10";
  if (isAnswered) return "border-emerald-500/30 bg-zinc-900/50";
  return "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700";
}

export function StageQaDrawer({
  questions,
  activeBanner,
  isHost,
  currentUserId,
  onAskQuestion,
  onToggleUpvote,
  onAnswerQuestion,
  onReopenQuestion,
  onPinQuestion,
  onUnpinQuestion,
  isSubmitting,
  error: externalError = null,
}: Readonly<StageQaDrawerProps>) {
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QaFilter>("all");
  const [sortBy, setSortBy] = useState<QaSort>("popular");
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");

  const openCount = useMemo(
    () => questions.filter((q) => q.status !== "answered").length,
    [questions],
  );
  const answeredCount = questions.length - openCount;

  const filteredQuestions = useMemo(() => {
    const subset = questions.filter((q) => {
      if (filter === "open") return q.status !== "answered";
      if (filter === "answered") return q.status === "answered";
      return true;
    });

    return [...subset].sort((a, b) => {
      if (sortBy === "popular") {
        const diff = (b.upvoterIds?.length ?? 0) - (a.upvoterIds?.length ?? 0);
        if (diff !== 0) return diff;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });
  }, [questions, filter, sortBy]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || isSubmitting) return;
    setSubmitError(null);
    try {
      const ok = await onAskQuestion(trimmed);
      if (ok) {
        setDraft("");
      }
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Could not send question right now.",
      );
    }
  };

  const handleReplySubmit = async (e: FormEvent, questionId: string) => {
    e.preventDefault();
    if (isSubmitting) return;
    const text = replyDraft.trim();
    const ok = await onAnswerQuestion(questionId, text || undefined);
    if (ok) {
      setReplyDraft("");
      setReplyingToId(null);
    }
  };

  const visibleError = externalError ?? submitError;

  return (
    <div
      data-testid="stage-qa-drawer"
      className="flex min-h-0 flex-1 flex-col justify-between"
    >
      {questions.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-2">
          <div className="flex items-center gap-1 rounded-lg bg-zinc-950/80 p-0.5">
            {(
              [
                { id: "all", label: `All (${questions.length})` },
                { id: "open", label: `Open (${openCount})` },
                { id: "answered", label: `Answered (${answeredCount})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  filter === tab.id
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() =>
              setSortBy((prev) => (prev === "popular" ? "recent" : "popular"))
            }
            className="text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
          >
            {sortBy === "popular" ? "Top ↑" : "Recent"}
          </button>
        </div>
      )}

      <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {filteredQuestions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <Tv2 className="mb-2 h-8 w-8 text-zinc-600" />
            <p className="text-sm font-medium text-zinc-300">
              {questions.length === 0
                ? "No questions yet"
                : `No ${filter} questions`}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {isHost
                ? "Questions from participants appear here. Click Show on Screen to spotlight any question over the live video stage."
                : "Ask a question below or upvote questions from other participants."}
            </p>
          </div>
        ) : (
          filteredQuestions.map((q) => {
            const isPinned = activeBanner?.questionId === q.id;
            const upvoteCount = q.upvoterIds?.length ?? 0;
            const upvotedByMe = Boolean(
              currentUserId && q.upvoterIds?.includes(currentUserId),
            );
            const isAnswered = q.status === "answered";
            const isReplying = replyingToId === q.id;

            return (
              <div
                key={q.id}
                className={cn(
                  "rounded-xl border p-3 transition-colors",
                  getQuestionCardClasses(isPinned, isAnswered),
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-zinc-200">
                      {q.authorName}
                    </span>
                    {q.authorRole === "host" && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                        Host
                      </span>
                    )}
                    {isAnswered && (
                      <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                        Answered
                      </span>
                    )}
                    {isPinned && (
                      <span className="rounded border border-amber-400/40 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-300 uppercase">
                        ON SCREEN
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => onToggleUpvote(q.id)}
                    aria-label={`Upvote question (${upvoteCount})`}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                      upvotedByMe
                        ? "border-amber-500/50 bg-amber-500/20 text-amber-200"
                        : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700",
                    )}
                  >
                    <ThumbsUp className="h-3 w-3" />
                    <span className="tabular-nums">{upvoteCount}</span>
                  </button>
                </div>

                <p className="mt-1.5 break-words text-sm text-zinc-100">
                  {q.text}
                </p>

                {q.answerText && (
                  <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-xs text-emerald-100">
                    <p className="font-semibold text-emerald-300">
                      {q.answeredByName ?? "Host"}
                    </p>
                    <p className="mt-0.5 break-words text-zinc-200">
                      {q.answerText}
                    </p>
                  </div>
                )}

                {isHost && isReplying && (
                  <form
                    onSubmit={(e) => handleReplySubmit(e, q.id)}
                    className="mt-2 flex items-center gap-1.5"
                  >
                    <input
                      type="text"
                      value={replyDraft}
                      onChange={(e) => setReplyDraft(e.target.value)}
                      maxLength={MAX_STAGE_ANSWER_LENGTH}
                      placeholder="Write a concise reply..."
                      className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-white placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="rounded-lg bg-emerald-500 px-2.5 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReplyingToId(null);
                        setReplyDraft("");
                      }}
                      className="rounded-lg p-1 text-zinc-400 hover:text-zinc-200"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                )}

                {isHost && (
                  <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
                    {!isAnswered ? (
                      <>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => {
                            setReplyingToId((prev) =>
                              prev === q.id ? null : q.id,
                            );
                            setReplyDraft(q.answerText ?? "");
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50"
                        >
                          <CornerDownRight className="h-3 w-3" />
                          Reply
                        </button>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => onAnswerQuestion(q.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/15 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          Answered
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => onReopenQuestion(q.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Reopen
                      </button>
                    )}

                    {isPinned ? (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={onUnpinQuestion}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" />
                        Hide from screen
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => onPinQuestion(q)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:border-amber-500/50 hover:bg-amber-500/15 hover:text-amber-200 disabled:opacity-50"
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
        {visibleError && (
          <p className="mb-1.5 text-xs text-red-400">{visibleError}</p>
        )}
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
