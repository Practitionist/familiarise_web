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

type LineItem = { description: string; quantity: number; unitPrice: string };

const EMPTY_LINE: LineItem = { description: "", quantity: 1, unitPrice: "" };

/**
 * #1527 Q8 — the manual invoice composer, moved from the org Billing page to
 * the back-office org detail (ops issue the invoice an org requested). Same
 * API as before, `POST /api/organizations/[orgId]/billing-account/invoices`,
 * which admits a platform admin (billing-admin-gate.ts). The old tax-rate and
 * GSTIN fields were never sent, so they are gone rather than moved.
 */
export function InvoiceComposer({
  orgId,
  open,
  onOpenChange,
}: Readonly<{
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const [lineItems, setLineItems] = useState<LineItem[]>([EMPTY_LINE]);
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const setLine = (i: number, patch: Partial<LineItem>) =>
    setLineItems((prev) =>
      prev.map((li, j) => (j === i ? { ...li, ...patch } : li)),
    );

  async function createInvoice() {
    setError(null);
    const items = lineItems
      .filter((li) => li.description.trim())
      .map((li) => ({
        description: li.description.trim(),
        quantity: li.quantity,
        unitPrice: Math.round(Number.parseFloat(li.unitPrice || "0") * 100),
      }));
    if (items.length === 0) {
      setError("Add at least one line item.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/billing-account/invoices`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items,
            // Default due date: 60 days from today (NET-60) if not supplied.
            dueDate:
              dueDate ||
              new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
            issueImmediately: true,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorMessageFromBody(body, "Failed to create invoice"));
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ["org-billing-invoices", orgId],
      });
      setLineItems([EMPTY_LINE]);
      setDueDate("");
      onOpenChange(false);
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
              <div key={i} className="flex items-end gap-2">
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
              onClick={() => setLineItems([...lineItems, EMPTY_LINE])}
            >
              <Plus className="mr-1 h-4 w-4" /> Add line
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv-due">Due date</Label>
            <Input
              id="inv-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
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
