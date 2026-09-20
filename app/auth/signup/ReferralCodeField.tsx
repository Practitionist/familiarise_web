"use client";

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

/** The optional referral input with its live check underneath. */
export function ReferralCodeField({
  value,
  onChange,
  disabled,
}: Readonly<ReferralCodeFieldProps>) {
  const check = useReferralCodeCheck(value, true);
  const invalid = check.state === "invalid";
  return (
    <div className="grid gap-2 mt-4">
      <Label htmlFor="referral-code">Referral Code (optional)</Label>
      <Input
        id="referral-code"
        placeholder="Enter referral code"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
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
