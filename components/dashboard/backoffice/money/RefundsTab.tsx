"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { targetRefSchema } from "@/lib/backoffice/money-list-schemas";
import { OperatorTime } from "@/lib/time/operator-time";
import { callOpsDoor } from "./ops-door";
import { TargetCell } from "./TargetCell";
import { RefundDoorDialog, type RefundDoor } from "./RefundDoorDialog";

const NeedsHumanList = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      message: z.string(),
      createdAt: z.string(),
      paymentId: z.string().nullable(),
      /** A credit seat gets the credit door; a held paid seat, a stuck owed refund or a held top-up the refund door; a support remedy its case. */
      kind: z
        .enum([
          "credit",
          "held-paid-seat",
          "incident-no-show-claim",
          "stuck-owed-refund",
          "owed-already-held",
          "support-recommendation",
        ])
        .optional(),
      occurrenceId: z.string().nullish(),
      unitPaise: z.number().nullish(),
      /** A held top-up's amount, preset in the refund door. */
      amountPaise: z.number().nullish(),
      /** A paid top-up whose own hold may now be released. */
      holdRef: z.string().nullish(),
      releasable: z.boolean().optional(),
      caseId: z.string().nullish(),
      /** Record refs (plan, refund) kept out of the message. */
      details: z.string().nullish(),
      /** An ended credit plan: ops may answer that no credit is owed. */
      creditPlan: z.boolean().optional(),
      /** Who paid, and for which booking. */
      target: targetRefSchema.nullable().optional(),
    }),
  ),
});
type NeedsHuman = z.infer<typeof NeedsHumanList>["items"][number];

async function fetchNeeds(): Promise<{ items: NeedsHuman[] }> {
  const res = await fetch("/api/admin/refunds/needs-human");
  if (!res.ok) throw new Error("Failed to load");
  return NeedsHumanList.parse(await res.json());
}

/** #1834 — a held seat opens the refund door keyed to its session, at its unit. */
function doorFor(item: NeedsHuman) {
  const paymentId = item.paymentId ?? undefined;
  // A hand refund settles a stuck owed marker and unblocks the cancel.
  if (item.kind === "stuck-owed-refund") {
    return { door: "issue" as const, paymentId };
  }
  // Another door's refund held this one: refund its amount by hand, then release the hold.
  if (item.kind === "owed-already-held") {
    return {
      door: "issue" as const,
      paymentId,
      amountRupees:
        typeof item.amountPaise === "number"
          ? (item.amountPaise / 100).toFixed(2)
          : undefined,
    };
  }
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
  const basePath = `/dashboard/${tree}`;
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
  // The credit plan an operator is answering "no credit owed" for.
  const [closing, setClosing] = useState<string | null>(null);
  // The paid top-up whose hold an operator is releasing.
  const [releasing, setReleasing] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
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
                  <div className="min-w-0 flex-1 space-y-1">
                    {item.paymentId && item.target && (
                      <TargetCell
                        kind="Payment"
                        id={item.paymentId}
                        target={item.target}
                        basePath={basePath}
                      />
                    )}
                    <span>{item.message}</span>
                    <p className="text-xs text-muted-foreground">
                      <OperatorTime value={item.createdAt} />
                    </p>
                    {item.details && (
                      <details className="text-xs text-muted-foreground">
                        <summary>Details</summary>
                        {item.details}
                      </details>
                    )}
                  </div>
                  {item.kind === "support-recommendation" && item.caseId && (
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        href={`/dashboard/${tree}/support/c_${item.caseId}`}
                      >
                        Open case
                      </Link>
                    </Button>
                  )}
                  {item.kind !== "support-recommendation" &&
                    // The refund already went; ops review the strike and the earnings by hand.
                    item.kind !== "incident-no-show-claim" &&
                    item.paymentId &&
                    // A settled top-up only waits for its hold release, on the earning.
                    !(
                      item.kind === "owed-already-held" &&
                      typeof item.amountPaise !== "number"
                    ) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setOpen(doorFor(item))}
                      >
                        {item.kind === "held-paid-seat" ||
                        item.kind === "stuck-owed-refund" ||
                        item.kind === "owed-already-held"
                          ? "Issue refund"
                          : "Return credits"}
                      </Button>
                    )}
                  {item.releasable && item.holdRef && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReleasing(item.holdRef ?? null)}
                    >
                      Release hold
                    </Button>
                  )}
                  {item.creditPlan && item.paymentId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setClosing(item.paymentId)}
                    >
                      No credit owed
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
      {releasing !== null && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setReleasing(null)}
          title="Release the top-up's hold"
          description="The top-up is paid. This releases only its own hold; the earnings stay held while anything else holds them."
          confirmLabel="Release hold"
          requireReason={{}}
          onConfirm={async ({ reason }) => {
            await callOpsDoor("/api/admin/earnings/top-up-hold", {
              correlationId: releasing,
              reason,
            });
            toast({ title: "Hold released" });
            void queryClient.invalidateQueries({
              queryKey: ["money-refund-needs"],
            });
            setReleasing(null);
          }}
        />
      )}
      {closing !== null && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setClosing(null)}
          title="No credit owed"
          description="Nothing goes back to the buyer. The expert's earnings for this plan are released on the usual hold."
          confirmLabel="Close without credit"
          requireReason={{}}
          onConfirm={async ({ reason }) => {
            await callOpsDoor("/api/admin/refunds/credits/close", {
              paymentId: closing,
              reason,
            });
            toast({ title: "Closed — no credit owed" });
            void queryClient.invalidateQueries({
              queryKey: ["money-refund-needs"],
            });
            setClosing(null);
          }}
        />
      )}
    </Card>
  );
}
