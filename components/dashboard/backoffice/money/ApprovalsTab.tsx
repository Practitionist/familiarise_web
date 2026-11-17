"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import {
  proposalPageSchema,
  readListBody,
  type ProposalListItem,
} from "@/lib/backoffice/money-list-schemas";
import { proposalStatus } from "@/lib/labels/backoffice-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { formatCurrencyAmount } from "@/utils/formatting";
import { ReasonDialog } from "./ReasonDialog";
import { TargetCell } from "./TargetCell";
import { useOpsDoor } from "./ops-door";

const STATUSES = [
  "PROPOSED",
  "EXECUTED",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
] as const;
type Status = (typeof STATUSES)[number];
const queryKey = (status: Status) => ["money-approvals", status] as const;

async function fetchProposals(status: Status, page: number) {
  const params = new URLSearchParams({ status, page: String(page) });
  const res = await fetch(`/api/admin/ops-proposals?${params}`);
  return readListBody(res, proposalPageSchema, "Failed to load");
}

/** One proposal: what it does, what it points at, who asked, and the doors while it waits. */
function ProposalRow({
  p,
  viewerId,
  basePath,
  onDecide,
}: Readonly<{
  p: ProposalListItem;
  viewerId: string;
  basePath: string;
  onDecide: (decision: "approve" | "reject") => void;
}>) {
  const own = p.proposedBy?.id === viewerId;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">
            {p.action} ·{" "}
            {p.amountPaise === null
              ? "Unlimited"
              : formatCurrencyAmount(p.amountPaise, "INR")}
          </p>
          <StatusBadge {...proposalStatus(p.status)} size="sm" />
        </div>
        <div className="my-2">
          <TargetCell
            kind={p.targetKind}
            id={p.targetId}
            target={p.target}
            basePath={basePath}
          />
        </div>
        <p className="text-muted-foreground">{p.reason}</p>
        <p className="text-muted-foreground">
          Proposed by {p.proposedBy?.name ?? "a removed user"} on{" "}
          <OperatorTime value={p.createdAt} />
          {p.status === "PROPOSED" && (
            <>
              {" "}
              · expires <OperatorTime value={p.expiresAt} />
            </>
          )}
          {p.decidedBy ? ` · decided by ${p.decidedBy.name}` : ""}
        </p>
        {p.decisionReason && (
          <p className="text-muted-foreground">{p.decisionReason}</p>
        )}
      </div>
      {p.status === "PROPOSED" && (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={own}
            title={
              own ? "A different admin must approve your proposal" : undefined
            }
            onClick={() => onDecide("approve")}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDecide("reject")}
          >
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

/** Money actions above ₹25,000 held for a second admin; the proposer cannot approve their own. */
export function ApprovalsTab({ viewerId }: Readonly<{ viewerId: string }>) {
  const { basePath } = useBackofficeCapability();
  const [status, setStatus] = useState<Status>("PROPOSED");
  const [page, setPage] = useState(1);
  const [deciding, setDeciding] = useState<{
    proposal: ProposalListItem;
    decision: "approve" | "reject";
  } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKey(status), page],
    queryFn: () => fetchProposals(status, page),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const decide = useOpsDoor({
    success: deciding?.decision === "approve" ? "Approved and run" : "Rejected",
    invalidate: STATUSES.map(queryKey),
    onDone: () => setDeciding(null),
    onFailed: () => setDeciding(null),
  });
  const proposals = data?.proposals ?? [];
  // A failed load says so; an empty queue says it is empty.
  let listEmpty: ReactNode = null;
  if (proposals.length === 0) {
    listEmpty = error ? (
      <p className="text-sm text-destructive">Approvals could not load.</p>
    ) : (
      <p className="text-sm text-muted-foreground">
        {isLoading ? "Loading…" : "Nothing here."}
      </p>
    );
  }

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
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
          >
            {proposalStatus(s).label}
          </Button>
        ))}
      </div>
      <Card>
        <CardContent className="pt-6">
          {listEmpty ?? (
            <ul className="divide-y divide-border">
              {proposals.map((p) => (
                <ProposalRow
                  key={p.id}
                  p={p}
                  viewerId={viewerId}
                  basePath={basePath}
                  onDecide={(decision) =>
                    setDeciding({ proposal: p, decision })
                  }
                />
              ))}
            </ul>
          )}
          <TablePagination
            className="pt-4"
            page={page}
            pageSize={data?.pageSize ?? 20}
            total={data?.total ?? 0}
            onPageChange={setPage}
          />
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
