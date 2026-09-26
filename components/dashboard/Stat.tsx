import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { toneTextClass, type Tone } from "@/lib/ui/tone";
import { cn } from "@/utils/tailwind";

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** One line under the value that says what is late or what it counts. */
  hint?: ReactNode;
  /** Makes the whole tile a link; only then does it get a hover state. */
  href?: string;
  /** Colours the value only; the tile stays neutral (#1527). */
  tone?: Tone;
  icon?: LucideIcon;
  className?: string;
}

const TILE =
  "block rounded-xl border border-border bg-card p-4 shadow-elevation-1 sm:p-5";

/** One KPI tile (#1527 §15): no gradient, no motion, full-contrast text. */
export function Stat({
  label,
  value,
  hint,
  href,
  tone = "neutral",
  icon: Icon,
  className,
}: Readonly<StatProps>) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-muted-foreground">
          {label}
        </p>
        {Icon && (
          <Icon
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
      </div>
      <p
        className={cn(
          "mt-2 text-[26px] font-semibold leading-tight tracking-tight tabular-nums",
          toneTextClass(tone),
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          TILE,
          "transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={cn(TILE, className)}>{body}</div>;
}

/** 2 columns on mobile, 3 at md, `columns` (default 4) at lg. */
export function StatRow({
  children,
  columns = 4,
  className,
}: Readonly<{ children: ReactNode; columns?: 3 | 4; className?: string }>) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StatSkeleton({ className }: Readonly<{ className?: string }>) {
  return (
    <div className={cn(TILE, className)} aria-hidden>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-7 w-16" />
      <Skeleton className="mt-2 h-3 w-20" />
    </div>
  );
}
