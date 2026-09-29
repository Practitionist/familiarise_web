import * as React from "react";

import { cn } from "@/utils/tailwind";

/**
 * One empty state, instead of five.
 *
 * The expert profile page alone had five hand-rolled ones: a bare
 * `<p className="text-zinc-400">No pricing plans available</p>` with no icon
 * and no heading, a `w-16 h-16` circle in `ReviewsSection`, another in
 * `ClassesAndWebinars`, a fourth in `ExpertPricing`, and a plain `<p>` in
 * `SlotList`. The two listings had two more. They differed in icon size, copy
 * weight, vertical padding and — in one case — whether they had a border.
 *
 * An empty state is a *state of the product*, not a per-component flourish, so
 * it gets a primitive. Deliberately not a shadcn `alert`: this is a neutral,
 * centred, non-urgent message, and an alert reads as a problem.
 */
const EmptyState = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    icon?: React.ComponentType<{ className?: string }>;
    title: string;
    description?: React.ReactNode;
    action?: React.ReactNode;
    /** `inline` sits inside a panel and is tighter; `block` owns the view. */
    size?: "inline" | "block";
  }
>(
  (
    { className, icon: Icon, title, description, action, size = "block", ...props },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "block" ? "px-6 py-16" : "px-4 py-10",
        className,
      )}
      {...props}
    >
      {Icon && (
        <div
          className={cn(
            "mb-4 flex items-center justify-center rounded-full bg-muted text-muted-foreground",
            size === "block" ? "h-14 w-14" : "h-11 w-11",
          )}
        >
          <Icon
            className={cn(size === "block" ? "h-6 w-6" : "h-5 w-5")}
          />
        </div>
      )}
      {/* `text-base`/`text-sm` rather than the previous `text-xl` — an empty
          state is read inside a results list, not on a landing page, and 20px
          semibold there was louder than the content it was replacing. */}
      <p
        className={cn(
          "font-medium text-foreground",
          size === "block" ? "text-base" : "text-sm",
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1 max-w-sm text-pretty text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  ),
);
EmptyState.displayName = "EmptyState";

export { EmptyState };
