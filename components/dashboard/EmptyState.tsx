import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/tailwind";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** `inline` sits inside a card or table; `page` fills an empty page body. */
  variant?: "inline" | "page";
  className?: string;
}

/**
 * The one "nothing here yet" block (#1527 §15). Say what would appear here and
 * offer the action that creates it, when there is one.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = "inline",
  className,
}: Readonly<EmptyStateProps>) {
  const page = variant === "page";
  const Title = page ? "h2" : "p";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        page ? "py-16" : "py-8",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "mb-3 flex items-center justify-center rounded-full bg-muted",
            page ? "h-14 w-14" : "h-11 w-11",
          )}
        >
          <Icon
            className={cn(
              "text-muted-foreground",
              page ? "h-7 w-7" : "h-5 w-5",
            )}
            aria-hidden
          />
        </div>
      )}
      <Title
        className={cn(
          "font-medium text-foreground",
          page ? "text-base" : "text-sm",
        )}
      >
        {title}
      </Title>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
