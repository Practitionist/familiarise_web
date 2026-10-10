"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageCircle, Send, SmilePlus } from "lucide-react";
import {
  ALLOWED_CHAT_EMOJIS,
  MAX_STAGE_CHAT_LENGTH,
  type ChatReactionEmoji,
  type StageChatMessage,
} from "@/lib/meetings/stage-qa";
import { cn } from "@/utils/tailwind";

interface StageChatDrawerProps {
  messages: StageChatMessage[];
  currentUserId?: string;
  onSendMessage: (text: string) => Promise<void>;
  onToggleReaction: (
    messageId: string,
    emoji: ChatReactionEmoji,
  ) => Promise<void>;
  isSubmitting: boolean;
  error?: string | null;
}

const URL_SPLIT_PATTERN = /(https?:\/\/[^\s]+)/g;

function renderMessageTextWithLinks(text: string) {
  const parts = text.split(URL_SPLIT_PATTERN);
  return parts.map((part, idx) => {
    if (/^https?:\/\/[^\s]+$/.test(part)) {
      return (
        <a
          key={`${idx}-${part}`}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-amber-400/60 underline-offset-2 text-amber-300 hover:text-amber-200 break-all"
        >
          {part}
        </a>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function StageChatDrawer({
  messages,
  currentUserId,
  onSendMessage,
  onToggleReaction,
  isSubmitting,
  error: externalError = null,
}: Readonly<StageChatDrawerProps>) {
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openPickerForId, setOpenPickerForId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || isSubmitting) return;
    setSubmitError(null);
    try {
      await onSendMessage(trimmed);
      setDraft("");
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Could not send message right now.",
      );
    }
  };

  const visibleError = externalError ?? submitError;

  return (
    <div
      data-testid="stage-chat-drawer"
      className="flex h-[calc(100%-60px)] flex-col justify-between"
    >
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <MessageCircle className="mb-2 h-8 w-8 text-zinc-600" />
            <p className="text-sm font-medium text-zinc-300">No messages yet</p>
            <p className="mt-1 text-xs text-zinc-500">
              Share links, quick notes, or reactions with participants. Messages
              are saved to your session thread.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const activeReactionEntries = Object.entries(
              msg.reactions ?? {},
            ).filter(([, userIds]) => userIds.length > 0);
            const isPickerOpen = openPickerForId === msg.id;

            return (
              <div
                key={msg.id}
                className="group relative rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3 transition-colors hover:border-zinc-700"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-zinc-200">
                      {msg.authorName}
                    </span>
                    {msg.authorRole === "host" && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                        Host
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] tabular-nums text-zinc-500">
                      {formatMessageTime(msg.createdAt)}
                    </span>
                    <button
                      type="button"
                      title="React with emoji"
                      aria-label="React to message"
                      onClick={() =>
                        setOpenPickerForId((prev) =>
                          prev === msg.id ? null : msg.id,
                        )
                      }
                      className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      <SmilePlus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {isPickerOpen && (
                  <div
                    role="group"
                    aria-label="Quick emoji reactions"
                    className="mt-2 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-950 p-1 shadow-lg"
                  >
                    {ALLOWED_CHAT_EMOJIS.map((emoji) => {
                      const reactedByMe = Boolean(
                        currentUserId &&
                        msg.reactions?.[emoji]?.includes(currentUserId),
                      );
                      return (
                        <button
                          key={emoji}
                          type="button"
                          onClick={async () => {
                            setOpenPickerForId(null);
                            await onToggleReaction(msg.id, emoji);
                          }}
                          className={cn(
                            "rounded-md px-1.5 py-1 text-sm transition-transform hover:scale-110 hover:bg-zinc-800",
                            reactedByMe && "bg-amber-500/20",
                          )}
                        >
                          {emoji}
                        </button>
                      );
                    })}
                  </div>
                )}

                <p className="mt-1 break-words whitespace-pre-wrap text-sm text-zinc-100">
                  {renderMessageTextWithLinks(msg.text)}
                </p>

                {activeReactionEntries.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {activeReactionEntries.map(([emoji, userIds]) => {
                      const reactedByMe = Boolean(
                        currentUserId && userIds.includes(currentUserId),
                      );
                      return (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() =>
                            onToggleReaction(msg.id, emoji as ChatReactionEmoji)
                          }
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                            reactedByMe
                              ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                              : "border-zinc-800 bg-zinc-950/70 text-zinc-300 hover:border-zinc-700",
                          )}
                        >
                          <span>{emoji}</span>
                          <span className="tabular-nums text-[11px]">
                            {userIds.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
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
            maxLength={MAX_STAGE_CHAT_LENGTH}
            placeholder="Send a message..."
            className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-zinc-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || isSubmitting}
            title="Send message"
            className="rounded-xl bg-white p-2.5 text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
