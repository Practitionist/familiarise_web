"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "@/lib/errors/client-refusal";

import {
  createPayoutAccount,
  makeDefaultPayoutAccount,
  payoutSetupQueryKey,
  reverifyPayoutAccount,
  type CreatePayoutAccountInput,
  type ReverifyResult,
} from "./get-paid-api";

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI = /^[\w.-]{2,}@[a-zA-Z]{2,}$/;

/** Invalidate everything that reads the account: this page and the Earnings banner. */
export function usePayoutSetupInvalidation(consultantId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: payoutSetupQueryKey(consultantId),
      }),
      queryClient.invalidateQueries({
        queryKey: ["consultant-earnings-analytics", consultantId],
      }),
    ]);
}

/** The toast for a failed write: the server's sentence when it answered, else generic. */
export function useRefusalToast() {
  const { toast } = useToast();
  return (error: unknown, fallback: string) =>
    toast({
      title: "Not saved",
      description: isExpectedRefusal(error) ? userMessageFrom(error) : fallback,
      variant: "destructive",
    });
}

type Mode = "BANK_ACCOUNT" | "UPI";

/**
 * Manual entry: bank account (number + IFSC + holder) or a UPI id, both sent
 * to the existing POST route, which runs the standard ₹1 penny drop. The
 * account number lives in this form's state only for the length of the
 * request; the server stores its last four digits and nothing more.
 */
function describeAccountSaveOutcome(
  madeDefault: boolean,
  isVerified: boolean,
): string {
  if (!madeDefault) {
    return "Saved, but we could not make it your payout account yet — use Change to pick it.";
  }
  if (isVerified) {
    return "The ₹1 test deposit confirmed your account.";
  }
  return "We are confirming it with a ₹1 test deposit; check back in a minute.";
}

export function PayoutAccountForm({
  consultantId,
  disabled = false,
  makeDefault = false,
  onSaved,
}: Readonly<{
  consultantId: string;
  disabled?: boolean;
  /** True when another account exists — the new one replaces it as default. */
  makeDefault?: boolean;
  onSaved?: () => void;
}>) {
  const [mode, setMode] = useState<Mode>("BANK_ACCOUNT");
  const [holder, setHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [confirmNumber, setConfirmNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [upiId, setUpiId] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const invalidate = usePayoutSetupInvalidation(consultantId);
  const refusalToast = useRefusalToast();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (input: CreatePayoutAccountInput) => {
      const { account } = await createPayoutAccount(input);
      // The row exists from here on; a failed default switch is reported
      // as its own outcome, never as "not saved".
      let madeDefault = true;
      if (makeDefault && !account.isDefault) {
        madeDefault = await makeDefaultPayoutAccount(account.id).then(
          () => true,
          () => false,
        );
      }
      return { account, madeDefault };
    },
    onSuccess: async ({ account, madeDefault }) => {
      await invalidate();
      toast({
        title: account.isVerified ? "Account verified" : "Account saved",
        description: describeAccountSaveOutcome(
          madeDefault,
          account.isVerified,
        ),
      });
      setAccountNumber("");
      setConfirmNumber("");
      onSaved?.();
    },
    onError: (error) => refusalToast(error, "Could not save the account."),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    const accountHolderName = holder.trim();
    if (accountHolderName.length < 2) {
      setFieldError("Enter the name exactly as the bank has it.");
      return;
    }
    if (mode === "UPI") {
      const address = upiId.trim();
      if (!UPI.test(address)) {
        setFieldError("That does not look like a UPI id (name@bank).");
        return;
      }
      mutation.mutate({
        accountType: "UPI",
        accountHolderName,
        upiId: address,
      });
      return;
    }
    const number = accountNumber.replace(/\s+/g, "");
    if (!/^\d{9,18}$/.test(number)) {
      setFieldError("Account numbers are 9 to 18 digits.");
      return;
    }
    if (number !== confirmNumber.replace(/\s+/g, "")) {
      setFieldError("The two account numbers do not match.");
      return;
    }
    const code = ifsc.trim().toUpperCase();
    if (!IFSC.test(code)) {
      setFieldError("IFSC codes look like HDFC0001234.");
      return;
    }
    mutation.mutate({
      accountType: "BANK_ACCOUNT",
      accountHolderName,
      accountNumber: number,
      ifscCode: code,
    });
  };

  const modeButton = (value: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={
        mode === value
          ? "rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background"
          : "rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );

  return (
    <form
      onSubmit={submit}
      className="space-y-4"
      aria-label="Add a payout account"
    >
      <div className="inline-flex gap-1 rounded-lg border border-border p-1">
        {modeButton("BANK_ACCOUNT", "Bank account")}
        {modeButton("UPI", "UPI id")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="holder">Account holder name</Label>
          <Input
            id="holder"
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
            autoComplete="name"
            disabled={disabled}
          />
        </div>
        {mode === "BANK_ACCOUNT" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="acct">Account number</Label>
              <Input
                id="acct"
                inputMode="numeric"
                autoComplete="off"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acct2">Confirm account number</Label>
              <Input
                id="acct2"
                inputMode="numeric"
                autoComplete="off"
                value={confirmNumber}
                onChange={(e) => setConfirmNumber(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ifsc">IFSC</Label>
              <Input
                id="ifsc"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                placeholder="HDFC0001234"
                disabled={disabled}
              />
            </div>
          </>
        ) : (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="upi">UPI id</Label>
            <Input
              id="upi"
              value={upiId}
              onChange={(e) => setUpiId(e.target.value)}
              placeholder="name@bank"
              autoComplete="off"
              disabled={disabled}
            />
          </div>
        )}
      </div>

      {fieldError && (
        <p role="alert" className="text-sm text-red-600">
          {fieldError}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        We confirm the account with a ₹1 test deposit and keep only the last
        four digits.
      </p>
      <Button type="submit" disabled={disabled || mutation.isPending}>
        {mutation.isPending ? "Saving…" : "Save and verify"}
      </Button>
    </form>
  );
}

/** "Check again" for an account still waiting on its ₹1: the PATCH reverify action. */
export function ReverifyAccountButton({
  consultantId,
  accountId,
  onResult,
}: Readonly<{
  consultantId: string;
  accountId: string;
  onResult: (result: ReverifyResult) => void;
}>) {
  const invalidate = usePayoutSetupInvalidation(consultantId);
  const refusalToast = useRefusalToast();
  const mutation = useMutation({
    mutationFn: () => reverifyPayoutAccount(accountId),
    onSuccess: async (result) => {
      onResult(result);
      await invalidate();
    },
    onError: (error) =>
      refusalToast(error, "Bank verification is temporarily unavailable."),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
    >
      {mutation.isPending ? "Checking…" : "Check again"}
    </Button>
  );
}
