"use client";

import { Sparkles, X } from "lucide-react";
import type { StagePinnedBanner } from "@/lib/meetings/stage-qa";
import { cn } from "@/utils/tailwind";

interface StagePinnedBannerOverlayProps {
  banner: StagePinnedBanner | null;
  isHost: boolean;
  onUnpin: () => void;
  isUpdating?: boolean;
}

export function StagePinnedBannerOverlay({
  banner,
  isHost,
  onUnpin,
  isUpdating = false,
}: StagePinnedBannerOverlayProps) {
  if (!banner) return null;

  const initials = banner.authorName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      data-testid="stage-on-screen-banner"
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-auto fixed bottom-24 left-6 z-30 max-w-md sm:max-w-lg",
        "animate-in fade-in slide-in-from-bottom-3 duration-200",
      )}
    >
      <div className="flex items-start gap-3.5 rounded-2xl border border-amber-500/40 bg-zinc-950/90 px-4 py-3.5 shadow-2xl backdrop-blur-xl">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-500/25 to-amber-600/10 border border-amber-400/30 text-sm font-semibold text-amber-300">
          {initials || "Q"}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-xs font-semibold text-zinc-200">
              {banner.authorName}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-300 uppercase">
              <Sparkles className="h-2.5 w-2.5" />
              ON SCREEN
            </span>
          </div>
          <p className="mt-1 break-words text-sm leading-snug font-medium text-white">
            {banner.text}
          </p>
        </div>

        {isHost && (
          <button
            type="button"
            disabled={isUpdating}
            onClick={onUnpin}
            title="Hide from stage"
            className="shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
