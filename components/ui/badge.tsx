import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/utils/tailwind";

const badgeVariants = cva(
  // `rounded-chip` (6px), `focus-visible:`, and a single ring offset of 2 —
  // the old base used `rounded-md`, bare `focus:`, and mixed offsets with the
  // rest of the system, so the same pill behaved three ways depending on
  // which primitive it was composed with.
  "inline-flex items-center rounded-chip border px-2 py-0.5 text-[0.6875rem] font-medium leading-5 tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        // Filled variants carried a bare `shadow` (Tailwind's stock
        // 0 1px 3px black/10) which is off the elevation scale — on a 20px-tall
        // pill it also read as a smudge. Dropped in favour of the surface and
        // border doing the work.
        default: "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        success: "border-transparent bg-success text-success-foreground",
        warning: "border-transparent bg-warning text-warning-foreground",
        info: "border-transparent bg-info text-info-foreground",
        // The accent. Several call sites were hand-rolling a one-off pill to
        // carry the brand colour; this is that pill.
        brand: "border-transparent bg-brand text-brand-foreground",
        "brand-subtle":
          "border-brand-border bg-brand-subtle text-brand-foreground-subtle",
        // The neutral, quiet chip. Preferred for a status or category that
        // should not compete with the price.
        outline: "border-border bg-transparent text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge };
