"use client";

import { Badge } from "@/components/ui/badge";
import { Clock } from "lucide-react";
import { cn } from "@/utils/tailwind";

interface WaitlistBadgeProps {
  position: number | null;
  variant?: "compact" | "extended";
  className?: string;
}

export function WaitlistBadge({
  position,
  variant = "compact",
  className,
}: WaitlistBadgeProps) {
  if (position === null || position === undefined) {
    return null;
  }

  if (variant === "compact") {
    return (
      <Badge
        className={cn(
          "bg-amber-100 text-amber-800 border-amber-300 font-semibold",
          className
        )}
      >
        #{position}
      </Badge>
    );
  }

  return (
    <Badge
      className={cn(
        "bg-amber-100 text-amber-800 border-amber-300 flex items-center gap-1.5",
        className
      )}
    >
      <Clock className="h-3 w-3" />
      <span>Waitlist Position #{position}</span>
    </Badge>
  );
}

export default WaitlistBadge;
