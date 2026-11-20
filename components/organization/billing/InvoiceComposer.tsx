"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { toOperatorWallTime } from "@/lib/time/operator-zone";

type LineItem = {
  key: string;
  description: string;
  quantity: number;
  unitPrice: string;
};

// #1527 review — a stable key per row so removing a middle row doesn't
// misattribute focus/DOM state to the wrong input (Sonar S6479).
let lineItemSeq = 0;
function makeEmptyLine(): LineItem {
  lineItemSeq += 1;
  return {
    key: `line-${lineItemSeq}`,
    description: "",
    quantity: 1,
    unitPrice: "",
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The terms-default due instant and the India date the picker shows for it. */
function defaultInvoiceDue(paymentTermsDays: number): {
  at: Date;
  day: string;
} {
  const at = new Date(Date.now() + paymentTermsDays * DAY_MS);
  return { at, day: toOperatorWallTime(at).slice(0, 10) };
}

/** An untouched (or cleared) field sends the terms-default instant at submit; an edited date is sent as typed. */
function invoiceDueDateBody(
  picked: string,
  edited: boolean,
  paymentTermsDays: number,
): string {
  return edited && picked
    ? picked
    : defaultInvoiceDue(paymentTermsDays).at.toISOString();
}

/**
 * The back-office manual invoice composer: ops issue the invoice an org
 * requested through the audited admin door, with a required reason.
 */
export function InvoiceComposer({
  orgId,
  paymentTermsDays,
  open,
  onOpenChange,
}: Readonly<{
  orgId: string;
  /** The org's own terms; the due date starts this many days after today. */
  paymentTermsDays: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const [lineItems, setLineItems] = useState<LineItem[]>([makeEmptyLine()]);
  const [dueDate, setDueDate] = useState(
    () => defaultInvoiceDue(paymentTermsDays).day,
  );
  const [dueEdited, setDueEdited] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const setLine = (i: number, patch: Partial<LineItem>) =>
    setLineItems((prev) =>
      prev.map((li, j) => (j === i ? { ...li, ...patch } : li)),
    );

  async function createInvoice() {
    setError(null);
    // #1527 review — quantity/unitPrice are free-typed; clamp and validate
    // before the POST rather than letting a negative or NaN value through.
    const items = lineItems
      .filter((li) => li.description.trim())
      .map((li) => ({
        description: li.description.trim(),
        quantity: Math.max(1, Math.trunc(li.quantity) || 1),
        unitPrice: Math.round(Number.parseFloat(li.unitPrice || "0") * 100),
      }));
    if (items.length === 0) {
      setError("Add at least one line item.");
      return;
    }
    if (
      items.some((it) => !Number.isFinite(it.unitPrice) || it.unitPrice < 0)
    ) {
      setError("Enter a valid, non-negative price for every line item.");
      return;
    }
    if (reason.trim().length < 5) {
      setError("Give a reason of at least 5 characters.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/admin/organizations/${orgId}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          dueDate: invoiceDueDateBody(dueDate, dueEdited, paymentTermsDays),
          issueImmediately: true,
          reason: reason.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorMessageFromBody(body, "Failed to create invoice"));
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ["org-billing-invoices", orgId],
      });
      setLineItems([makeEmptyLine()]);
      setDueDate(defaultInvoiceDue(paymentTermsDays).day);
      setDueEdited(false);
      setReason("");
      onOpenChange(false);
    } catch {
      // #1527 review — the fetch itself (network failure) had no catch, so it
      // surfaced as an unhandled rejection instead of the modal's error state.
      setError("Failed to create invoice. Check your connection and retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-lg">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Create manual invoice</ResponsiveModalTitle>
        </ResponsiveModalHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Line items</Label>
            {lineItems.map((li, i) => (
              <div key={li.key} className="flex items-end gap-2">
                <Input
                  aria-label="Description"
                  placeholder="Description"
                  value={li.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                  className="flex-1"
                />
                <Input
                  aria-label="Quantity"
                  placeholder="Qty"
                  type="number"
                  min={1}
                  value={li.quantity}
                  onChange={(e) =>
                    setLine(i, {
                      quantity: Number.parseInt(e.target.value) || 1,
                    })
                  }
                  className="w-16"
                />
                <Input
                  aria-label="Unit price in rupees"
                  placeholder="Price (INR)"
                  type="number"
                  min={0}
                  step="0.01"
                  value={li.unitPrice}
                  onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                  className="w-28"
                />
                {lineItems.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove line"
                    onClick={() =>
                      setLineItems(lineItems.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLineItems([...lineItems, makeEmptyLine()])}
            >
              <Plus className="mr-1 h-4 w-4" /> Add line
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv-due">Due date (Net {paymentTermsDays})</Label>
            <Input
              id="inv-due"
              type="date"
              value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value);
                setDueEdited(true);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv-reason">Reason</Label>
            <Input
              id="inv-reason"
              placeholder="Why ops is raising this invoice"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={createInvoice} disabled={pending}>
            Create invoice
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
