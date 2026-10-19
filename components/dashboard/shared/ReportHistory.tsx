"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const historySchema = z.object({
  reports: z.array(
    z.object({
      reportId: z.string(),
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
  const [scope, setScope] = useState<"submitted" | "decisions">("submitted");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["personal-report-history", session?.user.id, scope, page],
    enabled: Boolean(session?.user.id),
    queryFn: async () => {
      const response = await fetch(
        `/api/user/reports?scope=${scope}&page=${page}&limit=10`,
      );
      if (!response.ok) throw new Error("Could not load report history");
      return historySchema.parse(await response.json());
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reports and moderation decisions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant={scope === "submitted" ? "default" : "outline"}
            onClick={() => {
              setScope("submitted");
              setPage(1);
            }}
          >
            Your reports
          </Button>
          <Button
            variant={scope === "decisions" ? "default" : "outline"}
            onClick={() => {
              setScope("decisions");
              setPage(1);
            }}
          >
            Decisions affecting you
          </Button>
        </div>
        {query.isLoading ? (
          <p>Loading report history…</p>
        ) : query.isError ? (
          <div role="alert">
            Could not load report history.{" "}
            <Button variant="link" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : query.data?.reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {scope === "submitted"
              ? "Reports you submit appear here with a personal reference and outcome."
              : "No moderation decisions affecting your content or account."}
          </p>
        ) : (
          <ul className="divide-y">
            {query.data?.reports.map((report) => (
              <li
                key={report.reportId}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
              >
                <span className="font-medium">{report.reference}</span>
                <span>{new Date(report.createdAt).toLocaleDateString()}</span>
                <span>{outcomeLabels[report.outcome]}</span>
              </li>
            ))}
          </ul>
        )}
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
      </CardContent>
    </Card>
  );
}
