"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupeesToPaise } from "@/lib/backoffice/rupees";
import { refundableBalancePaise } from "@/lib/payments/refundable-balance";
import { needsTypedConfirm } from "@/lib/ui/typed-confirm";
import type { PaymentDetail } from "@/types/payments";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useToast } from "@/hooks/use-toast";
import { callOpsDoor } from "./ops-door";

export type RefundDoor = "issue" | "override" | "credits";

const COPY: Record<
  RefundDoor,
  { title: string; description: string; confirm: string }
> = {
  issue: {
    title: "Issue a refund",
    description:
      "Enter an amount, or tick the full refund to return everything still refundable on this payment.",
    confirm: "Refund",
  },
  override: {
    title: "Refund at an overridden tier",
    description:
      "The cancellation quote, with every notice tier replaced by this percentage.",
    confirm: "Refund at this tier",
  },
  credits: {
    title: "Return sessions of credits",
    description:
      "For a class seat paid in credits. While the seat is live, only sessions the host cancelled and did not make up; once it is released, any undelivered session.",
    confirm: "Return credits",
  },
};

const INVALIDATE = [
  ["admin-refunds"],
  ["money-refund-needs"],
  ["class-series"],
];

/** Payment ids are cuid/uuid; don't look one up while it is half-typed. */
const looksLikeId = (id: string) => id.length >= 20;

async function fetchPayment(id: string): Promise<PaymentDetail> {
  const res = await fetch(`/api/admin/payments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Payment not found");
  return res.json() as Promise<PaymentDetail>;
}

/**
 * #1771 K-5 — the three admin refund doors behind one dialog, opened empty
 * from the Refunds tab or pre-filled from a payment or a class seat.
 *
 * #1527 Q10 — the refundable remainder is shown, a blank amount is no longer
 * a silent full refund (the operator ticks "Full refund of ₹X"), and a refund
 * at or above the threshold needs a typed confirmation.
 */
export function RefundDoorDialog({
  door,
  presetPaymentId,
  presetOccurrenceId,
  presetAmountRupees,
  onClose,
}: Readonly<{
  door: RefundDoor | null;
  presetPaymentId?: string;
  /** #1834 — a held-seat item: the refund is keyed to this session. */
  presetOccurrenceId?: string;
  presetAmountRupees?: string;
  onClose: () => void;
}>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [paymentId, setPaymentId] = useState(presetPaymentId ?? "");
  const [value, setValue] = useState(presetAmountRupees ?? "");
  const [full, setFull] = useState(false);
  const id = (presetPaymentId ?? paymentId).trim();
  // One key per set of inputs: a double-click or a retry of the same refund
  // reuses it, while a corrected payment or amount is a new refund.
  const inputs = `${door}|${id}|${full ? "full" : value}`;
  const [keyed, setKeyed] = useState(() => ({
    inputs,
    key: globalThis.crypto.randomUUID(),
  }));
  if (keyed.inputs !== inputs) {
    setKeyed({ inputs, key: globalThis.crypto.randomUUID() });
  }
  const idempotencyKey = keyed.key;

  const payment = useQuery({
    queryKey: ["refund-door-payment", id],
    queryFn: () => fetchPayment(id),
    enabled: door !== null && door !== "credits" && looksLikeId(id),
    staleTime: 10_000,
    retry: false,
  });
  if (!door) return null;

  const copy = COPY[door];
  const p = payment.data;
  const remainder = p ? refundableBalancePaise(Number(p.amount), p) : null;
  const money = (paise: number) =>
    formatCurrencyAmount(paise, p?.currency ?? "INR");
  const num = Number(value);
  const paise = rupeesToPaise(value);

  // The amount the typed confirmation is judged on: the entered amount, the
  // remainder for a full refund, and the remainder as the ceiling of a tier.
  let atStakePaise = 0;
  if (door === "issue") atStakePaise = full ? (remainder ?? 0) : (paise ?? 0);
  if (door === "override") atStakePaise = remainder ?? 0;
  const typed = needsTypedConfirm(atStakePaise) ? "REFUND" : undefined;

  const validationError = (): string | null => {
    if (!id) return "Enter the payment id.";
    if (door === "issue") {
      if (full) return null;
      if (!paise || paise <= 0)
        return "Enter an amount, or tick the full refund.";
      if (remainder !== null && paise > remainder)
        return `At most ${money(remainder)} is still refundable.`;
      return null;
    }
    if (door === "override")
      return value !== "" && num >= 0 && num <= 100
        ? null
        : "Enter a percentage from 0 to 100.";
    return Number.isInteger(num) && num >= 1
      ? null
      : "Enter a whole number of sessions.";
  };

  const body = (): Record<string, unknown> => {
    const session = presetOccurrenceId
      ? { occurrenceId: presetOccurrenceId }
      : {};
    if (door === "issue")
      return full
        ? { paymentId: id, ...session }
        : { paymentId: id, amountPaise: paise, ...session };
    if (door === "override") return { paymentId: id, tierOverridePct: num };
    return { paymentId: id, sessions: Math.round(num) };
  };
  const valueLabel = {
    issue: "Amount in rupees",
    override: "Refund percentage (0–100)",
    credits: "Sessions to return",
  }[door];

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={copy.title}
      description={copy.description}
      confirmLabel={
        door === "issue" && full && remainder !== null
          ? `Full refund of ${money(remainder)}`
          : copy.confirm
      }
      tone="destructive"
      requireReason={{}}
      requireTyped={typed}
      onConfirm={async ({ reason }) => {
        const problem = validationError();
        if (problem) throw new Error(problem);
        await callOpsDoor(
          door === "credits"
            ? "/api/admin/refunds/credits"
            : "/api/admin/refunds/issue",
          { ...body(), idempotencyKey, reason },
        );
        toast({ title: "Done — the refund is on its way" });
        for (const key of INVALIDATE)
          void queryClient.invalidateQueries({ queryKey: key });
        onClose();
      }}
    >
      {presetPaymentId ? (
        <p className="text-sm text-muted-foreground">
          Payment {presetPaymentId}
        </p>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="door-payment">Payment id</Label>
          <Input
            id="door-payment"
            value={paymentId}
            onChange={(e) => setPaymentId(e.target.value)}
          />
        </div>
      )}
      {door !== "credits" && remainder !== null && (
        <p className="text-sm">
          Still refundable:{" "}
          <span className="font-medium tabular-nums">{money(remainder)}</span>{" "}
          of {money(Number(p?.amount ?? 0))}
        </p>
      )}
      {door !== "credits" && payment.isError && (
        <p className="text-sm text-destructive">
          No payment with this id was found.
        </p>
      )}
      {door === "issue" && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="door-full"
            checked={full}
            onCheckedChange={(c) => setFull(c === true)}
          />
          <Label htmlFor="door-full">
            {remainder === null
              ? "Full refund of everything still refundable"
              : `Full refund of ${money(remainder)}`}
          </Label>
        </div>
      )}
      {!(door === "issue" && full) && (
        <div className="space-y-1.5">
          <Label htmlFor="door-value">{valueLabel}</Label>
          <Input
            id="door-value"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
      )}
    </ConfirmDialog>
  );
}
