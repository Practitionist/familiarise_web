import { cn } from "@/utils/tailwind";
import { toneClass, type Tone } from "@/lib/ui/tone";

export interface StatusBadgeProps {
  label: string;
  /** #1527: the preferred input. Colours come from `lib/ui/tone.ts`. */
  tone?: Tone;
  /** Legacy style input from the `lib/labels` maps; wins over `tone`. */
  className?: string;
  dotClassName?: string;
  /** Render the leading status dot on the pill. */
  withDot?: boolean;
  size?: "sm" | "md";
  /** `dot`: a coloured dot and plain text, for dense tables and lists. */
  variant?: "pill" | "dot";
}

/**
 * The one status renderer for every dashboard. Pass a tone directly or spread
 * a `lib/labels` style:
 *
 *   <StatusBadge label="Paid" tone="success" />
 *   <StatusBadge {...appointmentStatusBadge(booking.status)} />
 *
 * Keeping it dumb (label + colour in, span out) means every status shares one
 * geometry, and colour semantics live in the tone module.
 */
export function StatusBadge({
  label,
  tone,
  className,
  dotClassName,
  withDot = false,
  size = "md",
  variant = "pill",
}: Readonly<StatusBadgeProps>) {
  const toned = toneClass(tone ?? "neutral");
  // A legacy style without a dot colour keeps rendering no dot.
  const dot = dotClassName ?? (tone ? toned.dotClassName : undefined);
  const textSize = size === "sm" ? "text-[11px]" : "text-xs";

  if (variant === "dot") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap text-foreground",
          textSize,
        )}
      >
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            dot ?? toned.dotClassName,
          )}
          aria-hidden
        />
        {label}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5" : "px-2.5 py-0.5",
        textSize,
        className ?? toned.className,
      )}
    >
      {withDot && dot && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full shrink-0", dot)}
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}
