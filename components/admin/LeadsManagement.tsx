"use client";

/**
 * Enterprise leads pipeline: `Lead` rows newest-first with a status filter.
 * A status move asks for a reason, which lands in the audit log; a 409 means
 * another operator moved the lead first, so the dialog shows the reload hint.
 */

import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { LeadStatus } from "@prisma/client";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { opsReasonSchema } from "@/lib/backoffice/ops-reason";
import { readListBody } from "@/lib/backoffice/money-list-schemas";
import {
  leadPageSchema,
  type LeadRow,
} from "@/lib/backoffice/people-list-schemas";
import { LEAD_STATUS, leadStatus } from "@/lib/labels/backoffice-labels";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { OperatorTime } from "@/lib/time/operator-time";

const STATUSES: Array<LeadStatus | "ALL"> = [
  "ALL",
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "CLOSED_WON",
  "CLOSED_LOST",
];

// Mirrors ALLOWED_FROM in the PATCH route — the dropdown offers only
// reachable targets so operators never see a 409 for picking NEW on an
// already-new lead or skipping the qualification step.
const NEXT_STATUSES: Record<LeadStatus, LeadStatus[]> = {
  NEW: ["CONTACTED", "CLOSED_LOST"],
  CONTACTED: ["QUALIFIED", "CLOSED_LOST"],
  QUALIFIED: ["CLOSED_WON", "CLOSED_LOST"],
  CLOSED_WON: [],
  CLOSED_LOST: [],
};

const STATUS_LABEL = (s: LeadStatus) => LEAD_STATUS[s].label;

export function LeadsManagement() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [move, setMove] = useState<{ lead: LeadRow; to: LeadStatus } | null>(
    null,
  );

  // The API pages 50 rows at a time; older leads load on demand.
  const query = useInfiniteQuery({
    queryKey: ["admin-leads", statusFilter],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (pageParam) params.set("cursor", pageParam);
      const res = await fetch(`/api/admin/leads?${params.toString()}`);
      return readListBody(res, leadPageSchema, "Failed to load leads");
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const leads = query.data?.pages.flatMap((p) => p.leads) ?? [];

  // Throws keep the dialog open with the message shown inside it.
  const transition = async (
    id: string,
    from: LeadStatus,
    status: LeadStatus,
    raw?: string,
  ) => {
    const reason = opsReasonSchema.safeParse(raw ?? "");
    if (!reason.success) {
      throw new Error(reason.error.issues[0]?.message ?? "Give a reason.");
    }
    const res = await fetch(`/api/admin/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, status, reason: reason.data }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || "Update failed");
    }
    await queryClient.invalidateQueries({ queryKey: ["admin-leads"] });
  };

  return (
    <>
      <DashboardHeader
        title="Enterprise leads"
        subtitle="Inquiries from the enterprise funnel — work them to Won or Lost"
        actions={
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v)}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "ALL" ? "All statuses" : STATUS_LABEL(s as LeadStatus)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="space-y-3">
        {/* A failed load says so; only a loaded, empty view says it is empty. */}
        {query.isError && (
          <p role="alert" className="text-sm text-destructive">
            Failed to load leads.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </p>
        )}
        {leads.length === 0 && !query.isFetching && !query.isError && (
          <p className="text-sm text-zinc-500">No leads in this view.</p>
        )}
        {leads.map((lead) => (
          <div
            key={lead.id}
            className="rounded-lg border bg-card p-4 space-y-2"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">
                  {lead.companyName ?? lead.contactName}{" "}
                  <span className="text-xs text-zinc-400">
                    · {lead.sourceCategory}
                  </span>
                </p>
                <a
                  href={`mailto:${lead.contactEmail}`}
                  className="text-sm text-blue-600 hover:underline"
                >
                  {lead.contactEmail}
                </a>
                {lead.phone && (
                  <span className="ml-2 text-sm text-zinc-500">
                    {lead.phone}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge {...leadStatus(lead.status)} size="sm" />
                {NEXT_STATUSES[lead.status].length > 0 ? (
                  <Select
                    value={lead.status}
                    onValueChange={(v) => {
                      const to = NEXT_STATUSES[lead.status].find(
                        (s) => s === v,
                      );
                      if (to) setMove({ lead, to });
                    }}
                  >
                    <SelectTrigger className="w-36" id={`status-${lead.id}`}>
                      {/* Current status is excluded from the successor
                          items, so render its label as the trigger value. */}
                      <SelectValue>{STATUS_LABEL(lead.status)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {/* Only reachable targets — mirrors the route's
                          ALLOWED_FROM table so the UI can't offer a move
                          the API would reject. */}
                      {NEXT_STATUSES[lead.status].map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABEL(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-zinc-500">Closed</span>
                )}
                <Button size="sm" variant="outline" asChild>
                  <a href={`mailto:${lead.contactEmail}`}>Reply</a>
                </Button>
              </div>
            </div>
            <p className="text-sm font-medium">{lead.subject}</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-600 line-clamp-3">
              {lead.message}
            </p>
            <p className="text-xs text-zinc-400">
              Received <OperatorTime value={lead.createdAt} />
            </p>
          </div>
        ))}
      </div>
      {query.hasNextPage && (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
      <ConfirmDialog
        open={move !== null}
        onOpenChange={(open) => {
          if (!open) setMove(null);
        }}
        title={
          move
            ? `Move ${move.lead.companyName ?? move.lead.contactName} to ${STATUS_LABEL(move.to)}?`
            : ""
        }
        description="The reason is kept in the audit log with the move."
        confirmLabel="Move lead"
        requireReason={{
          label: "Reason",
          placeholder: "What happened with this lead?",
        }}
        onConfirm={async ({ reason }) => {
          if (move)
            await transition(move.lead.id, move.lead.status, move.to, reason);
        }}
      />
    </>
  );
}
