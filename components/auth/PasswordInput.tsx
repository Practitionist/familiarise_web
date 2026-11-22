"use client";

import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/utils/tailwind";

type PasswordInputProps = Omit<ComponentPropsWithoutRef<typeof Input>, "type">;

/** A password input with a show/hide toggle, so users can check what they typed. */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, disabled, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    const Icon = visible ? EyeOff : Eye;
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
          disabled={disabled}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
