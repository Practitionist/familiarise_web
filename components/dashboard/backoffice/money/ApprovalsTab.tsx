"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import type { ProposalListItem } from "@/lib/backoffice/ops-proposals";
import { useZonedFormat } from "@/lib/time/zoned-format";
import { formatCurrencyAmount } from "@/utils/formatting";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

const STATUSES = [
  "PROPOSED",
  "EXECUTED",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
] as const;
type Status = (typeof STATUSES)[number];
const WHEN = "d MMM yyyy, hh:mm a";
const queryKey = (status: Status) => ["money-approvals", status] as const;

async function fetchProposals(status: Status): Promise<ProposalListItem[]> {
  const res = await fetch(`/api/admin/ops-proposals?status=${status}`);
  if (!res.ok) throw new Error("Failed to load");
  const json = (await res.json()) as { proposals: ProposalListItem[] };
  return json.proposals;
}

/** Money actions above ₹25,000 held for a second admin; the proposer cannot approve their own. */
export function ApprovalsTab({ viewerId }: Readonly<{ viewerId: string }>) {
  const zoned = useZonedFormat();
  const [status, setStatus] = useState<Status>("PROPOSED");
  const [deciding, setDeciding] = useState<{
    proposal: ProposalListItem;
    decision: "approve" | "reject";
  } | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: queryKey(status),
    queryFn: () => fetchProposals(status),
    staleTime: 10_000,
  });
  const decide = useOpsDoor({
    success: deciding?.decision === "approve" ? "Approved and run" : "Rejected",
    invalidate: STATUSES.map(queryKey),
    onDone: () => setDeciding(null),
    onFailed: () => setDeciding(null),
  });
  const proposals = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="With two or more admins, a refund, invoice or credit action above ₹25,000 waits here until a different admin approves it. A proposal expires after 24 hours."
      />
      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === status ? "default" : "outline"}
            onClick={() => setStatus(s)}
          >
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </Button>
        ))}
      </div>
      <Card>
        <CardContent className="pt-6">
          {proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isLoading ? "Loading…" : "Nothing here."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {proposals.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {p.action} ·{" "}
                      {p.amountPaise === null
                        ? "Unlimited"
                        : formatCurrencyAmount(p.amountPaise, "INR")}
                    </p>
                    <p className="text-muted-foreground">
                      {p.targetKind} {p.targetId}
                    </p>
                    <p className="text-muted-foreground">{p.reason}</p>
                    <p className="text-muted-foreground">
                      Proposed by {p.proposedBy?.name ?? "a removed user"} on{" "}
                      {zoned(p.createdAt, WHEN)}
                      {p.status === "PROPOSED"
                        ? ` · expires ${zoned(p.expiresAt, WHEN)}`
                        : ""}
                      {p.decidedBy ? ` · decided by ${p.decidedBy.name}` : ""}
                    </p>
                    {p.decisionReason && (
                      <p className="text-muted-foreground">
                        {p.decisionReason}
                      </p>
                    )}
                  </div>
                  {p.status === "PROPOSED" && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={p.proposedBy?.id === viewerId}
                        title={
                          p.proposedBy?.id === viewerId
                            ? "A different admin must approve your proposal"
                            : undefined
                        }
                        onClick={() =>
                          setDeciding({ proposal: p, decision: "approve" })
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setDeciding({ proposal: p, decision: "reject" })
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <ReasonDialog
        open={deciding !== null}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={
          deciding?.decision === "approve"
            ? "Approve and run this action"
            : "Reject this proposal"
        }
        description={
          deciding?.decision === "approve"
            ? "The action runs now, as you, with the proposer's request."
            : "Nothing runs; the proposer can propose it again."
        }
        confirmLabel={deciding?.decision === "approve" ? "Approve" : "Reject"}
        pending={decide.isPending}
        onConfirm={(reason) =>
          deciding &&
          decide.mutate({
            url: `/api/admin/ops-proposals/${deciding.proposal.id}/${deciding.decision}`,
            body: { reason },
          })
        }
      />
    </div>
  );
}
