"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OperatorTime } from "@/lib/time/operator-time";
import {
  fromOperatorWallTime,
  operatorEndKind,
} from "@/lib/time/operator-zone";

const previewSchema = z.object({
  token: z.string(),
  appointmentIds: z.array(z.string()),
  confirmation: z.string(),
  bookings: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      sessions: z.number(),
      participants: z.array(z.string()),
      participantCount: z.number(),
    }),
  ),
});
type Preview = z.infer<typeof previewSchema>;
const requestsSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
      createdAt: z.string(),
      completedAt: z.string().nullable(),
      items: z.array(
        z.object({
          appointmentId: z.string(),
          completedAt: z.string().nullable(),
          attempts: z.number(),
          lastError: z.string().nullable(),
        }),
      ),
    }),
  ),
});
type RemediationRequest = z.infer<typeof requestsSchema>["requests"][number];

/** The preview request for an IST From/Until pair typed into the two inputs. */
export function previewBody(
  windowId: string,
  startsAt: string,
  endsAt: string,
) {
  const from = fromOperatorWallTime(startsAt);
  const until = fromOperatorWallTime(endsAt);
  if (!from || !until) throw new Error("Enter both times in full (IST).");
  return {
    windowId,
    startsAt: from.toISOString(),
    endsAt: until.toISOString(),
  };
}

export function MaintenanceBookingRemediation({
  windowId,
}: Readonly<{
  windowId: string;
}>) {
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState<RemediationRequest[]>([]);
  const [statusError, setStatusError] = useState("");
  const loadRequests = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/admin/maintenance/booking-remediation?windowId=${encodeURIComponent(windowId)}`,
      );
      if (!response.ok)
        throw new Error("Unable to load cancellation progress.");
      const data: unknown = await response.json();
      setRequests(requestsSchema.parse(data).requests);
      setStatusError("");
    } catch {
      setStatusError("Unable to load cancellation progress. Retry refresh.");
    }
  }, [windowId]);
  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);
  async function submit(confirm: boolean) {
    setBusy(true);
    try {
      const body =
        confirm && preview
          ? { token: preview.token, confirmation: preview.confirmation, reason }
          : previewBody(windowId, startsAt, endsAt);
      const response = await fetch(
        "/api/admin/maintenance/booking-remediation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data: unknown = await response.json();
      const error = z.object({ error: z.string() }).safeParse(data);
      if (!response.ok)
        throw new Error(error.success ? error.data.error : "Request failed");
      if (confirm) {
        setPreview(null);
        setMessage(
          "Confirmed cancellations queued. They run after maintenance ends; retries use the same durable request.",
        );
        await loadRequests();
      } else {
        setPreview(previewSchema.parse(data));
        setMessage("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      setMessage(message);
      if (confirm) throw new Error(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Booking remediation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Going offline does not cancel bookings. Preview up to 20 overlapping
          bookings, then explicitly confirm cancellation. This cancels each
          whole booking and uses the existing full refund policy; recurring
          bookings can include sessions outside this interval.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>
            From (IST)
            <Input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => {
                setStartsAt(e.target.value);
                setPreview(null);
              }}
            />
          </Label>
          <Label>
            Until (IST)
            <Input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => {
                setEndsAt(e.target.value);
                setPreview(null);
              }}
            />
          </Label>
        </div>
        <Label>
          Audit reason
          <Input
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Label>
        <Button
          variant="outline"
          disabled={busy || !startsAt || !endsAt || reason.trim().length < 5}
          onClick={() => submit(false)}
        >
          Preview cancellations
        </Button>
        {preview && (
          <div className="space-y-3">
            <p>
              {preview.appointmentIds.length} bookings selected. Preview expires
              in 5 minutes.
            </p>
            <ul className="space-y-2 text-sm">
              {preview.bookings.map((booking) => (
                <li key={booking.id} className="rounded border p-3">
                  <p className="font-medium">
                    {booking.type} · {booking.sessions} session(s)
                  </p>
                  <p>
                    <OperatorTime value={booking.startsAt} /> –{" "}
                    <OperatorTime
                      value={booking.endsAt}
                      kind={operatorEndKind(booking.startsAt, booking.endsAt)}
                    />
                  </p>
                  <p>
                    {booking.participants.join(", ") ||
                      "No active participants"}
                    {booking.participantCount > booking.participants.length
                      ? ` and ${booking.participantCount - booking.participants.length} more`
                      : ""}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {booking.id}
                  </p>
                </li>
              ))}
            </ul>
            <ConfirmDialog
              trigger={
                <Button
                  variant="destructive"
                  disabled={busy || reason.trim().length < 5}
                >
                  Confirm booking cancellations
                </Button>
              }
              title="Cancel these bookings?"
              description="Cancellation and full refund obligations are durable. This action cannot be undone by ending maintenance."
              requireTyped={preview.confirmation}
              confirmLabel="Queue cancellations"
              tone="destructive"
              onConfirm={() => submit(true)}
            />
          </div>
        )}
        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">Recent cancellation requests</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadRequests()}
            >
              Refresh progress
            </Button>
          </div>
          {statusError && (
            <p role="alert" className="text-sm">
              {statusError}
            </p>
          )}
          {requests.map((request) => (
            <div key={request.id} className="rounded border p-3 text-sm">
              <p className="font-medium">
                {request.completedAt ? "Complete" : "Queued"} ·{" "}
                {request.items.filter((item) => item.completedAt).length}/
                {request.items.length} bookings processed
              </p>
              <p>{request.reason}</p>
              <p className="text-muted-foreground">
                Requested <OperatorTime value={request.createdAt} />
              </p>
              {request.items
                .filter((item) => item.lastError)
                .map((item) => (
                  <p role="alert" key={item.appointmentId}>
                    {item.appointmentId}: {item.lastError} ({item.attempts}{" "}
                    attempt(s); retry pending)
                  </p>
                ))}
            </div>
          ))}
          {!requests.length && !statusError && (
            <p className="text-sm text-muted-foreground">
              No cancellation requests for this window.
            </p>
          )}
        </div>
        {message && <output className="block text-sm">{message}</output>}
      </CardContent>
    </Card>
  );
}
