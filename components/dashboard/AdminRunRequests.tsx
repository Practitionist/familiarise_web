"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Inbox } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import type { Tone } from "@/lib/ui/tone";
import { OperatorTime } from "@/lib/time/operator-time";

/** Polled only while a request is still REQUESTED or CLAIMED. */
const POLL_MS = 5_000;

const requestStatusSchema = z.enum(["REQUESTED", "CLAIMED", "DONE", "FAILED"]);
type RequestStatus = z.infer<typeof requestStatusSchema>;

const responseSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      job: z.string(),
      status: requestStatusSchema,
      attempts: z.number(),
      lastError: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
type RunRequest = z.infer<typeof responseSchema>["requests"][number];

const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  REQUESTED: { label: "Queued", tone: "caution" },
  CLAIMED: { label: "Running", tone: "info" },
  DONE: { label: "Done", tone: "success" },
  FAILED: { label: "Failed", tone: "critical" },
};

/** Admin runs that answer before they finish; the ticker retries a lost one within the hour. */
export function AdminRunRequests({
  refreshKey,
}: Readonly<{ refreshKey: number }>) {
  const [requests, setRequests] = useState<RunRequest[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/staff/system-jobs/requests");
      if (!response.ok) return;
      const parsed = responseSchema.safeParse(await response.json());
      if (parsed.success) setRequests(parsed.data.requests);
    } catch (error) {
      console.error("Error fetching run requests:", error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const open = requests.some(
    (r) => r.status === "REQUESTED" || r.status === "CLAIMED",
  );
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  if (requests.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="h-5 w-5" />
          Run requests
        </CardTitle>
        <CardDescription>
          Background runs started from this page, newest first
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {requests.map((request) => (
            <div
              key={request.id}
              className="flex flex-col gap-1 p-3 rounded-lg border border-border sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium text-sm truncate">{request.job}</p>
                <p className="text-xs text-muted-foreground">
                  <OperatorTime value={request.createdAt} /> • attempts:{" "}
                  {request.attempts}
                  {request.lastError ? ` • ${request.lastError}` : ""}
                </p>
              </div>
              <StatusBadge {...REQUEST_STATUS[request.status]} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
