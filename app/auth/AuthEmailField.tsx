"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError, invalidProps } from "@/components/ui/field-error";

interface AuthEmailFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled: boolean;
  /** The server's sentence for this field, shown inline until the next keystroke. */
  error?: string;
  className?: string;
}

/** The email input the sign-in and sign-up pages share, with its inline error. */
export function AuthEmailField({
  value,
  onChange,
  onBlur,
  disabled,
  error,
  className = "grid gap-2",
}: Readonly<AuthEmailFieldProps>) {
  return (
    <div className={className}>
      <Label htmlFor="email">Email</Label>
      <Input
        id="email"
        placeholder="name@example.com"
        type="email"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        required
        disabled={disabled}
        {...invalidProps(error, "email-error")}
      />
      <FieldError id="email-error" message={error} />
    </div>
  );
}
