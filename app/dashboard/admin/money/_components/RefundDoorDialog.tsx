"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupeesToPaise } from "@/lib/backoffice/rupees";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

export type RefundDoor = "issue" | "override" | "credits";

const COPY: Record<
  RefundDoor,
  { title: string; description: string; confirm: string }
> = {
  issue: {
    title: "Issue a refund",
    description:
      "Leave the amount empty to refund everything still refundable on this payment.",
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
      "For a class seat paid in credits: gives back this many sessions' worth. The seat stays.",
    confirm: "Return credits",
  },
};

/**
 * #1771 K-5 — the three admin refund doors behind one dialog, opened empty
 * from the Refunds tab or pre-filled for a seat from the Class-series tab.
 */
export function RefundDoorDialog({
  door,
  presetPaymentId,
  onClose,
}: Readonly<{
  door: RefundDoor | null;
  presetPaymentId?: string;
  onClose: () => void;
}>) {
  const [paymentId, setPaymentId] = useState(presetPaymentId ?? "");
  const [value, setValue] = useState("");
  // One key per set of inputs: a double-click or a retry of the same refund
  // reuses it, while a corrected payment or amount is a new refund.
  const inputs = `${door}|${paymentId}|${value}`;
  const [keyed, setKeyed] = useState(() => ({
    inputs,
    key: globalThis.crypto.randomUUID(),
  }));
  if (keyed.inputs !== inputs) {
    setKeyed({ inputs, key: globalThis.crypto.randomUUID() });
  }
  const idempotencyKey = keyed.key;
  const mutation = useOpsDoor({
    success: "Done — the refund is on its way",
    invalidate: [["admin-refunds"], ["money-refund-needs"], ["class-series"]],
    onDone: () => {
      setValue("");
      onClose();
    },
  });
  if (!door) return null;
  const copy = COPY[door];
  const num = Number(value);
  const paise = rupeesToPaise(value);
  const valueOk = {
    issue: value === "" || (paise ?? 0) > 0,
    override: value !== "" && num >= 0 && num <= 100,
    credits: Number.isInteger(num) && num >= 1,
  }[door];
  const body = (): Record<string, unknown> => {
    const id = (presetPaymentId ?? paymentId).trim();
    if (door === "issue")
      return value === ""
        ? { paymentId: id }
        : { paymentId: id, amountPaise: paise };
    if (door === "override") return { paymentId: id, tierOverridePct: num };
    return { paymentId: id, sessions: Math.round(num) };
  };
  const valueLabel = {
    issue: "Amount in rupees (optional)",
    override: "Refund percentage (0–100)",
    credits: "Sessions to return",
  }[door];

  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirm}
      pending={mutation.isPending}
      canConfirm={valueOk && (presetPaymentId ?? paymentId).trim() !== ""}
      onConfirm={(reason) =>
        mutation.mutate({
          url:
            door === "credits"
              ? "/api/admin/refunds/credits"
              : "/api/admin/refunds/issue",
          body: { ...body(), idempotencyKey, reason },
        })
      }
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
      <div className="space-y-1.5">
        <Label htmlFor="door-value">{valueLabel}</Label>
        <Input
          id="door-value"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </ReasonDialog>
  );
}
