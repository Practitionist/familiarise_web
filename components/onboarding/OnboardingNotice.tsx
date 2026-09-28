"use client";

/**
 * Inline notice inside the onboarding card.
 *
 * Replaces three hand-rolled blocks that each hard-coded `border-amber-500/40
 * bg-amber-500/10 text-amber-600 dark:text-amber-500`. That spelling is raw
 * Tailwind, not the design system's: the `warning` token already exists
 * (`hsl(38 92% 50%)`, with a `.dark` value in globals.css) and the
 * `AlertTriangle` icon is the app's established warning marker.
 *
 * Routing colour through a token is what makes this work inside the shell's
 * `.dark` scope — `text-warning` resolves to the dark value automatically,
 * where the raw amber pair would have needed a hand-written `dark:` override
 * that a future theme could not override.
 */

import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/utils/tailwind";
import type { ReactNode } from "react";

type Tone = "warning" | "info";

const TONE_ICON: Record<Tone, typeof AlertTriangle> = {
  warning: AlertTriangle,
  info: Info,
};

const TONE_CLASS: Record<Tone, string> = {
  warning: "border-warning/40 bg-warning/10",
  info: "border-info/40 bg-info/10",
};

const TONE_ICON_CLASS: Record<Tone, string> = {
  warning: "text-warning",
  info: "text-info",
};

export function OnboardingNotice({
  tone = "warning",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      // `role="status"` rather than `alert`: these are informational, and
      // `alert` implies assertive interruption. The draft banners can appear
      // after the user has already started typing, so an assertive live region
      // would talk over them.
      role="status"
      className={cn(
        "mb-6 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm",
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_ICON_CLASS[tone])} />
      <span className="text-foreground">{children}</span>
    </div>
  );
}
