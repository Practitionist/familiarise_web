"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefundDoorDialog, type RefundDoor } from "./RefundDoorDialog";

interface NeedsHuman {
  id: string;
  message: string;
  createdAt: string;
  paymentId: string | null;
  /** A credit seat gets the credit door, a held paid seat the refund door, a support remedy its case. */
  kind?: "credit" | "held-paid-seat" | "support-recommendation";
  occurrenceId?: string | null;
  unitPaise?: number | null;
  caseId?: string | null;
}

async function fetchNeeds(): Promise<{ items: NeedsHuman[] }> {
  const res = await fetch("/api/admin/refunds/needs-human");
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<{ items: NeedsHuman[] }>;
}

/** #1834 — a held seat opens the refund door keyed to its session, at its unit. */
function doorFor(item: NeedsHuman) {
  const paymentId = item.paymentId ?? undefined;
  if (item.kind !== "held-paid-seat") {
    return { door: "credits" as const, paymentId };
  }
  return {
    door: "issue" as const,
    paymentId,
    occurrenceId: item.occurrenceId ?? undefined,
    amountRupees:
      typeof item.unitPaise === "number"
        ? (item.unitPaise / 100).toFixed(2)
        : undefined,
  };
}

/**
 * #1771 K-5 — the admin half of the Refunds tab: the three refund doors and
 * the credit seats the automatic paths left for a human.
 */
export function RefundDoorsPanel() {
  const params = useSearchParams();
  const tree = useParams<{ tree?: string }>()?.tree ?? "admin";
  const linkedPayment = params.get("paymentId");
  // A booking's Ops actions link here with `?door=issue&paymentId=…`.
  const [open, setOpen] = useState<{
    door: RefundDoor;
    paymentId?: string;
    occurrenceId?: string;
    amountRupees?: string;
  } | null>(
    params.get("door") === "issue" && linkedPayment
      ? { door: "issue", paymentId: linkedPayment }
      : null,
  );
  const { data } = useQuery({
    queryKey: ["money-refund-needs"],
    queryFn: fetchNeeds,
    staleTime: 30_000,
  });
  const items = data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Refund doors</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOpen({ door: "issue" })}>
            Issue refund
          </Button>
          <Button
            variant="outline"
            onClick={() => setOpen({ door: "override" })}
          >
            Ladder override
          </Button>
          <Button
            variant="outline"
            onClick={() => setOpen({ door: "credits" })}
          >
            Return sessions of credits
          </Button>
        </div>
        {items.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Refunds waiting for a human</p>
            <ul className="divide-y divide-border rounded-md border">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                >
                  <span className="min-w-0 flex-1">{item.message}</span>
                  {item.kind === "support-recommendation" && item.caseId && (
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        href={`/dashboard/${tree}/support/c_${item.caseId}`}
                      >
                        Open case
                      </Link>
                    </Button>
                  )}
                  {item.kind !== "support-recommendation" && item.paymentId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOpen(doorFor(item))}
                    >
                      {item.kind === "held-paid-seat"
                        ? "Issue refund"
                        : "Return credits"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <RefundDoorDialog
        key={`${open?.door}-${open?.paymentId ?? ""}-${open?.occurrenceId ?? ""}`}
        door={open?.door ?? null}
        presetPaymentId={open?.paymentId}
        presetOccurrenceId={open?.occurrenceId}
        presetAmountRupees={open?.amountRupees}
        onClose={() => setOpen(null)}
      />
    </Card>
  );
}
