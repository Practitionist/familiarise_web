"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { KeyValueList, Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldError, invalidProps } from "@/components/ui/field-error";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import type { Tone } from "@/lib/ui/tone";

type AccountStatus =
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "FAILED_VERIFICATION"
  | "SUSPENDED";

interface PayoutAccount {
  accountHolderName: string;
  accountNumberLast4: string;
  bankName: string;
  ifscCode: string | null;
  status: AccountStatus;
  verifiedAt: string | null;
}

const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: Tone }> = {
  PENDING_VERIFICATION: { label: "Confirming", tone: "caution" },
  VERIFIED: { label: "Verified", tone: "success" },
  FAILED_VERIFICATION: { label: "Couldn't verify", tone: "critical" },
  SUSPENDED: { label: "Suspended", tone: "critical" },
};

// Same checks as the consultant Get-paid form (PayoutAccountForm.tsx).
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER = /^\d{9,18}$/;

const queryKey = (orgId: string) => ["org-payout-account", orgId] as const;

interface FormErrors {
  holder?: string;
  bankName?: string;
  accountNumber?: string;
  confirm?: string;
  ifsc?: string;
}

function AccountForm({
  orgId,
  onSaved,
}: Readonly<{ orgId: string; onSaved: () => void }>) {
  const [holder, setHolder] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [confirmNumber, setConfirmNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const save = useMutation({
    mutationFn: async (body: Record<string, string>) => {
      const res = await fetch(`/api/organizations/${orgId}/payout-account`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          errorMessageFromBody(json, "Could not save the account."),
        );
      }
      return json as { payoutAccount: PayoutAccount };
    },
    onSuccess: async ({ payoutAccount }) => {
      await queryClient.invalidateQueries({ queryKey: queryKey(orgId) });
      toast({
        title:
          payoutAccount.status === "VERIFIED"
            ? "Account verified"
            : "Account saved",
        description:
          payoutAccount.status === "VERIFIED"
            ? "The ₹1 test deposit confirmed the account."
            : "We are confirming it with a ₹1 test deposit; check back in a minute.",
      });
      setAccountNumber("");
      setConfirmNumber("");
      onSaved();
    },
    onError: (err: Error) =>
      toast({
        title: "Not saved",
        description: err.message,
        variant: "destructive",
      }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const number = accountNumber.replace(/\s+/g, "");
    const code = ifsc.trim().toUpperCase();
    const next: FormErrors = {};
    if (holder.trim().length < 2) {
      next.holder = "Enter the name exactly as the bank has it.";
    }
    if (bankName.trim().length === 0) next.bankName = "Enter the bank's name.";
    if (!ACCOUNT_NUMBER.test(number)) {
      next.accountNumber = "Account numbers are 9 to 18 digits.";
    } else if (number !== confirmNumber.replace(/\s+/g, "")) {
      next.confirm = "The two account numbers do not match.";
    }
    if (!IFSC.test(code)) next.ifsc = "IFSC codes look like HDFC0001234.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate({
      accountHolderName: holder.trim(),
      bankName: bankName.trim(),
      accountNumber: number,
      ifscCode: code,
    });
  };

  const field = (
    id: keyof FormErrors,
    label: string,
    value: string,
    onChange: (v: string) => void,
    extra: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`payout-${id}`}>{label}</Label>
      <Input
        id={`payout-${id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...invalidProps(errors[id], `payout-${id}-error`)}
        {...extra}
      />
      <FieldError id={`payout-${id}-error`} message={errors[id]} />
    </div>
  );

  return (
    <form
      onSubmit={submit}
      className="max-w-3xl space-y-4"
      aria-label="Organization payout account"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {field("holder", "Account holder name", holder, setHolder, {
          autoComplete: "name",
        })}
        {field("bankName", "Bank name", bankName, setBankName)}
        {field(
          "accountNumber",
          "Account number",
          accountNumber,
          setAccountNumber,
          {
            inputMode: "numeric",
            autoComplete: "off",
          },
        )}
        {field(
          "confirm",
          "Confirm account number",
          confirmNumber,
          setConfirmNumber,
          {
            inputMode: "numeric",
            autoComplete: "off",
          },
        )}
        {field("ifsc", "IFSC", ifsc, setIfsc, {
          autoCapitalize: "characters",
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        The full account number goes to our payout partner once to confirm the
        account with a ₹1 test deposit. We keep only its last four digits.
      </p>
      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save account"}
      </Button>
    </form>
  );
}

/**
 * Payouts › Payout account (#1527 Q6): the bank account org payouts settle
 * to. GET is MANAGER+ (read-only here); PUT is OWNER-only on the server, so
 * only an owner sees the form.
 */
export function PayoutAccountPanel({
  orgId,
  canEdit,
}: Readonly<{ orgId: string; canEdit: boolean }>) {
  const [editing, setEditing] = useState(false);
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: queryKey(orgId),
    queryFn: async (): Promise<PayoutAccount | null> => {
      const res = await fetch(`/api/organizations/${orgId}/payout-account`);
      if (!res.ok) throw new Error("Failed to load the payout account");
      const json = (await res.json()) as {
        payoutAccount: PayoutAccount | null;
      };
      return json.payoutAccount;
    },
  });

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load the payout account"
        onRetry={() => void refetch()}
      />
    );
  }

  if (!data || editing) {
    if (!canEdit) {
      return (
        <EmptyState
          title="No payout account yet"
          description="An owner of this organization adds the bank account payouts are sent to."
        />
      );
    }
    return (
      <Section
        title={data ? "Change payout account" : "Add a payout account"}
        description="Payout runs send this organization's share to this account."
        actions={
          data ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : undefined
        }
      >
        <AccountForm orgId={orgId} onSaved={() => setEditing(false)} />
      </Section>
    );
  }

  const status = ACCOUNT_STATUS[data.status];
  return (
    <Section
      title="Payout account"
      description="Payout runs send this organization's share here."
      variant="card"
      actions={
        canEdit ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        ) : undefined
      }
    >
      <KeyValueList
        items={[
          { label: "Status", value: <StatusBadge {...status} /> },
          { label: "Account holder", value: data.accountHolderName },
          { label: "Bank", value: data.bankName },
          { label: "Account", value: `•••• ${data.accountNumberLast4}` },
          { label: "IFSC", value: data.ifscCode ?? "—" },
        ]}
      />
    </Section>
  );
}
