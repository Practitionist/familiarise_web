"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { z } from "zod";
import { AppealAction } from "@/components/support/resolution/AppealAction";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateLabel } from "@/lib/time/display";

const historySchema = z.object({
  reports: z.array(
    z.object({
      reportId: z.string(),
      moderationActionId: z.string().nullable().optional(),
      appealUntil: z.string().nullable().optional(),
      reference: z.string(),
      type: z.string(),
      createdAt: z.string(),
      outcome: z.enum([
        "PENDING_REVIEW",
        "NO_ACTION_TAKEN",
        "CONTENT_REMOVED",
        "EXCLUDED_FROM_AGGREGATE",
        "POLICY_ACTION_TAKEN",
      ]),
    }),
  ),
  pagination: z.object({ totalPages: z.number() }),
});

const outcomeLabels = {
  PENDING_REVIEW: "Awaiting review",
  NO_ACTION_TAKEN: "No action taken",
  CONTENT_REMOVED: "Content removed",
  EXCLUDED_FROM_AGGREGATE: "Excluded from rating",
  POLICY_ACTION_TAKEN: "Policy action taken",
};

/** Personal reporting receipts and enforcement decisions, without other users' evidence. */
export function ReportHistory() {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"submitted" | "decisions">("submitted");
  const [page, setPage] = useState(1);
  const queryKey = ["personal-report-history", session?.user.id, scope, page];
  const query = useQuery({
    queryKey,
    enabled: Boolean(session?.user.id),
    queryFn: async () => {
      const response = await fetch(
        `/api/user/reports?scope=${scope}&page=${page}&limit=10`,
      );
      if (!response.ok) throw new Error("Could not load report history");
      return historySchema.parse(await response.json());
    },
  });

  let history: ReactNode;
  if (query.isPending) {
    history = <p>Loading report history…</p>;
  } else if (query.isError) {
    history = (
      <div role="alert">
        Could not load report history.{" "}
        <Button variant="link" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (query.data.reports.length === 0) {
    history = (
      <p className="text-sm text-muted-foreground">
        {scope === "submitted"
          ? "Reports you submit appear here with a personal reference and outcome."
          : "No moderation decisions affecting your content or account."}
      </p>
    );
  } else {
    history = (
      <ul className="divide-y">
        {query.data.reports.map((report) => (
          <li key={report.reportId} className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{report.reference}</span>
              <span>{formatDateLabel(new Date(report.createdAt))}</span>
              <span>{outcomeLabels[report.outcome]}</span>
            </div>
            {report.moderationActionId &&
              report.appealUntil &&
              new Date(report.appealUntil).getTime() >= Date.now() && (
                <AppealAction
                  target={{ moderationActionId: report.moderationActionId }}
                  onSubmitted={() => void qc.invalidateQueries({ queryKey })}
                />
              )}
          </li>
        ))}
      </ul>
    );
  }
  const panel = (
    <>
      {history}
      {query.data && query.data.pagination.totalPages > 1 && (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="text-sm">
            Page {page} of {query.data.pagination.totalPages}
          </span>
          <Button
            variant="outline"
            disabled={page >= query.data.pagination.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
  return (
    <Tabs
      value={scope}
      onValueChange={(value) => {
        setScope(z.enum(["submitted", "decisions"]).parse(value));
        setPage(1);
      }}
    >
      <TabsList aria-label="Reports and decisions">
        <TabsTrigger value="submitted">Your reports</TabsTrigger>
        <TabsTrigger value="decisions">Decisions affecting you</TabsTrigger>
      </TabsList>
      <TabsContent value="submitted" className="space-y-4">
        {scope === "submitted" && panel}
      </TabsContent>
      <TabsContent value="decisions" className="space-y-4">
        {scope === "decisions" && panel}
      </TabsContent>
    </Tabs>
  );
}
