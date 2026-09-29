import * as React from "react";

import { cn } from "@/utils/tailwind";

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // h-9 (36px) was a button height, not a text-field height — the
          // caret sat in a box too short to type into comfortably. h-10
          // matches the Select trigger and the default Button size, so a form
          // row of mixed primitives lines up.
          // `bg-background` rather than transparent, so an input keeps its own
          // surface when placed on `--surface` or `--surface-sunken`.
          // `rounded-control`, and ring-offset-2 to agree with Button and Badge.
          "flex h-10 w-full rounded-control border border-input bg-background px-3 py-2 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/30 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
