"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Tone } from "@/lib/ui/tone";
import { cn } from "@/utils/tailwind";
import { HelpCircle, LucideIcon } from "lucide-react";
import { Stat, StatSkeleton } from "./Stat";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  tooltip?: string;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
}

const VARIANT_TONE: Record<NonNullable<StatCardProps["variant"]>, Tone> = {
  default: "neutral",
  success: "success",
  warning: "warning",
  danger: "critical",
  info: "info",
};

/**
 * Compatibility wrapper over `Stat` (#1527) for the pages that still pass the
 * old props. New code uses `Stat` directly.
 */
export function StatCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  tooltip,
  variant = "default",
  className,
}: Readonly<StatCardProps>) {
  const label = tooltip ? (
    <span className="inline-flex items-center gap-1">
      {title}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle
              className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground"
              aria-label={tooltip}
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  ) : (
    title
  );

  const hint =
    subtitle || trend ? (
      <>
        {subtitle}
        {trend && (
          <span className={cn("block", subtitle && "mt-1")}>
            <span
              className={cn(
                "font-medium",
                trend.isPositive ? "text-green-700" : "text-red-700",
              )}
            >
              {trend.isPositive ? "↑" : "↓"} {Math.abs(trend.value)}%
            </span>{" "}
            vs last period
          </span>
        )}
      </>
    ) : undefined;

  return (
    <Stat
      label={label}
      value={value}
      hint={hint}
      icon={icon}
      tone={VARIANT_TONE[variant]}
      className={className}
    />
  );
}

export const StatCardSkeleton = StatSkeleton;
