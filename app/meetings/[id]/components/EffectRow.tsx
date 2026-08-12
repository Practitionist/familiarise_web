"use client";

import { Loader2, type LucideIcon } from "lucide-react";

import { cn } from "@/utils/tailwind";

/**
 * One switch in the effects menu, so background blur and noise cancellation
 * read as the same kind of control rather than two different widgets.
 */
export function EffectRow({
  icon: Icon,
  label,
  hint,
  active,
  disabled,
  loading,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  active: boolean;
  disabled?: boolean;
  loading?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        disabled
          ? "cursor-not-allowed text-zinc-600"
          : active
            ? "bg-zinc-800 text-white"
            : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white",
      )}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
      {active && (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-white"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
