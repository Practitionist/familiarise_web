"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/utils/tailwind";
import {
  referralCheckText,
  useReferralCodeCheck,
} from "./useReferralCodeCheck";

interface ReferralCodeFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

/** The optional referral input, collapsed behind a link until there is a code. */
export function ReferralCodeField({
  value,
  onChange,
  disabled,
}: Readonly<ReferralCodeFieldProps>) {
  const [open, setOpen] = useState(value !== "");
  const check = useReferralCodeCheck(value, true);
  const invalid = check.state === "invalid";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-expanded={false}
        aria-controls="referral-code"
        className="mt-3 inline-flex items-center gap-1 text-sm text-zinc-400 underline-offset-4 hover:text-white hover:underline"
      >
        Have a referral code?
        <ChevronRight aria-hidden="true" className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="grid gap-2 mt-4">
      <Label htmlFor="referral-code">Referral code (optional)</Label>
      <Input
        id="referral-code"
        placeholder="Enter referral code"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={value === ""}
        aria-invalid={invalid ? true : undefined}
        aria-describedby="referral-code-status"
      />
      <output
        id="referral-code-status"
        htmlFor="referral-code"
        className={cn(
          "block text-sm",
          invalid ? "text-destructive" : "text-zinc-400",
        )}
      >
        {referralCheckText(check)}
      </output>
    </div>
  );
}
