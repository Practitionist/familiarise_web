"use client";

import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { z } from "zod";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  const [scope, setScope] = useState<"submitted" | "decisions">("submitted");
  const [page, setPage] = useState(1);
  const [appealing, setAppealing] = useState<string | null>(null);
  const [appealReason, setAppealReason] = useState("");
  const [sending, setSending] = useState(false);
  const appealId = useRef<string | null>(null);
  const { toast } = useToast();
  const sendAppeal = async () => {
    if (!appealing || !appealReason.trim() || sending) return;
    setSending(true);
    appealId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/support/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moderationActionId: appealing,
          reason: appealReason.trim(),
          clientIntakeId: appealId.current,
        }),
      });
      if (!response.ok) await throwSupportError(response, "appeal submission");
      setAppealing(null);
      setAppealReason("");
      appealId.current = null;
      toast({ title: "Appeal submitted for independent review" });
    } catch (error) {
      toast({
        title: "Appeal was not submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };
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

  let history: ReactNode;
  if (query.isLoading) {
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
  } else if (query.data?.reports.length === 0) {
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
        {query.data?.reports.map((report) => (
          <li
            key={report.reportId}
            className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
          >
            <span className="font-medium">{report.reference}</span>
            <span>{new Date(report.createdAt).toLocaleDateString()}</span>
            <span>{outcomeLabels[report.outcome]}</span>
            {report.moderationActionId &&
              report.appealUntil &&
              new Date(report.appealUntil).getTime() >= Date.now() && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAppealing(report.moderationActionId ?? null);
                    appealId.current = null;
                  }}
                >
                  Appeal decision
                </Button>
              )}
          </li>
        ))}
      </ul>
    );
  }
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
      <TabsContent value={scope} className="space-y-4">
        {history}
        {appealing && (
          <div className="space-y-2">
            <label htmlFor="moderation-appeal-reason">
              Why should this decision be reviewed?
            </label>
            <Textarea
              id="moderation-appeal-reason"
              maxLength={10000}
              value={appealReason}
              onChange={(event) => {
                setAppealReason(event.target.value);
                appealId.current = null;
              }}
              disabled={sending}
            />
            <div className="flex gap-2">
              <Button
                disabled={sending || !appealReason.trim()}
                onClick={() => void sendAppeal()}
              >
                {sending ? "Submitting…" : "Submit appeal"}
              </Button>
              <Button
                variant="ghost"
                disabled={sending}
                onClick={() => setAppealing(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
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
      </TabsContent>
    </Tabs>
  );
}
