"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Button } from "@/components/ui/button";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import {
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
} from "@/lib/support/disputes/protocol";

/**
 * The platform's buyer-dispute queue.
 *
 * A buyer dispute is NOT a gateway chargeback: it is a claim the buyer
 * raised against the expert (or the host organisation), which the platform
 * adjudicates. The two live side by side on the Money console because both
 * are "money the platform is holding that somebody says it should not be",
 * but they are different acts with different deadlines — a chargeback has
 * the gateway's `respond_by`, a buyer dispute has the respondent's
 * contractual window and then the platform's.
 */

const BuyerDisputesResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      referenceNumber: z.string(),
      caseId: z.string(),
      status: z.string(),
      reason: z.string(),
      round: z.number(),
      role: z.enum(["BUYER", "RESPONDENT"]),
      amountPaise: z.number(),
      respondentDueAt: z.string().nullable(),
      respondentRespondedAt: z.string().nullable(),
      buyerDecision: z.string().nullable(),
      escalatedAt: z.string().nullable(),
      resolvedAt: z.string().nullable(),
      createdAt: z.string(),
      respondentType: z.string(),
      respondentUserId: z.string().nullable(),
      respondentOrganizationId: z.string().nullable(),
    }),
  ),
});

export function BuyerDisputesPanel() {
  const { basePath } = useBackofficeCapability();
  const query = useQuery({
    queryKey: ["backoffice-buyer-disputes"],
    queryFn: async () => {
      const res = await fetch("/api/admin/buyer-disputes");
      if (!res.ok) throw new Error("We could not load the disputes.");
      return BuyerDisputesResponse.parse(await res.json()).data;
    },
  });

  const disputes = query.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Buyer disputes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Claims a learner raised against an expert or a host organisation.
          These are adjudicated by the platform; a gateway chargeback above is
          a different thing.
        </p>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.isError ? (
          <div role="alert" className="text-sm">
            We could not load the disputes.{" "}
            <Button variant="link" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : disputes.length === 0 ? (
          <EmptyState
            title="No buyer disputes"
            description="Claims raised by learners appear here with the deadline the expert has to answer."
          />
        ) : (
          <ul className="divide-y">
            {disputes.map((dispute) => {
              const overdue =
                dispute.status === "OPEN" &&
                dispute.respondentDueAt !== null &&
                new Date(dispute.respondentDueAt).getTime() < Date.now();
              return (
                <li
                  key={dispute.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="space-y-1">
                    <Link
                      href={`${basePath}/support/c_${dispute.caseId}`}
                      className="text-sm font-medium underline underline-offset-4"
                    >
                      {DISPUTE_REASON_LABEL[dispute.reason] ?? dispute.reason}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {dispute.referenceNumber} ·{" "}
                      {formatCurrencyAmount(dispute.amountPaise, "INR")} at
                      stake · round {dispute.round}
                      {overdue
                        ? " · the expert's window has passed"
                        : dispute.respondentDueAt
                          ? ` · answer by ${new Date(dispute.respondentDueAt).toLocaleDateString()}`
                          : ""}
                    </p>
                  </div>
                  <StatusBadge
                    label={
                      DISPUTE_STATUS_LABEL[
                        dispute.status as keyof typeof DISPUTE_STATUS_LABEL
                      ] ?? dispute.status
                    }
                    tone={
                      dispute.status === "RESOLVED"
                        ? "success"
                        : overdue
                          ? "critical"
                          : dispute.status === "ESCALATED" ||
                              dispute.status === "UNDER_REVIEW"
                            ? "info"
                            : "warning"
                    }
                    size="sm"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
