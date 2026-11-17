"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CaseAttachments } from "./CaseAttachments";
import { AppealAction } from "./resolution/AppealAction";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { FileCheck } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { humanizeEnum } from "@/lib/ui/tone";
import { invalidateSupportCase, supportKeys } from "@/lib/support/support-keys";
import { useZoneClock } from "@/lib/time/use-zone-clock";

const Evidence = z.object({
  id: z.string(),
  prompt: z.string(),
  dueAt: z.string(),
  respondedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  caseClosed: z.boolean(),
});
const List = z.object({ data: z.array(Evidence) });
const Detail = z.object({
  data: Evidence.extend({
    caseId: z.string(),
    responseBody: z.string().nullable(),
    booking: z
      .object({
        title: z.string().nullable(),
        startsAt: z.string().nullable(),
        organizationName: z.string().nullable(),
      })
      .nullable()
      .optional(),
    decisions: z.array(
      z.object({
        id: z.string(),
        outcome: z.string(),
        appealUntil: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
});

function evidenceStatus(
  request: z.infer<typeof Evidence>,
  pendingLabel: string,
) {
  if (request.cancelledAt) return "Cancelled";
  if (request.respondedAt) return "Response submitted";
  if (request.caseClosed) return "Investigation concluded";
  return pendingLabel;
}

export function EvidenceInbox({
  detailBase,
  organizationId,
}: Readonly<{ detailBase: string; organizationId?: string }>) {
  const { data: session } = useSession();
  const when = useZoneClock().dateTime;
  const [status, setStatus] = useState("all");
  const query = useQuery({
    queryKey: supportKeys.evidenceList(session?.user.id, organizationId),
    refetchOnMount: "always",
    enabled: Boolean(session?.user.id),
    queryFn: async () => {
      const response = await fetch(
        organizationId
          ? `/api/support/evidence?organizationId=${encodeURIComponent(organizationId)}`
          : "/api/support/evidence",
      );
      if (!response.ok)
        await throwSupportError(response, "evidence requests load");
      return List.parse(await response.json()).data;
    },
  });
  if (query.isPending) return <Skeleton className="h-32 w-full" />;
  if (query.isError)
    return (
      <ErrorState
        title="Couldn't load evidence requests"
        onRetry={() => void query.refetch()}
      />
    );
  const rows =
    query.data?.filter((row) => {
      if (status === "all") return true;
      if (status === "pending")
        return !row.respondedAt && !row.cancelledAt && !row.caseClosed;
      if (status === "submitted") return Boolean(row.respondedAt);
      return Boolean(row.cancelledAt);
    }) ?? [];
  return (
    <section className="space-y-4">
      <FilterBar
        selects={[
          {
            key: "status",
            label: "Status",
            value: status,
            options: [
              { value: "all", label: "All requests" },
              { value: "pending", label: "Needs response" },
              { value: "submitted", label: "Submitted" },
              { value: "cancelled", label: "Cancelled" },
            ],
            onChange: setStatus,
          },
        ]}
      />
      {rows.length === 0 && (
        <EmptyState
          icon={FileCheck}
          title="No evidence requests"
          description="Requests addressed to you will appear here with their prompt and response deadline."
        />
      )}
      {rows.map((request) => (
        <Link
          key={request.id}
          href={`${detailBase}/${request.id}`}
          className="block rounded-lg border border-border p-3 focus-visible:outline focus-visible:outline-2"
        >
          <p className="line-clamp-2">{request.prompt}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {evidenceStatus(request, `Respond by ${when(request.dueAt)}`)}
          </p>
        </Link>
      ))}
    </section>
  );
}

export function EvidenceRequest({
  requestId,
  inboxHref,
}: Readonly<{ requestId: string; inboxHref: string }>) {
  const { data: session } = useSession();
  const clock = useZoneClock();
  const when = clock.dateTime;
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const turnId = useRef<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const query = useQuery({
    queryKey: supportKeys.evidenceRequest(session?.user.id, requestId),
    enabled: Boolean(session?.user.id),
    queryFn: async () => {
      const response = await fetch(`/api/support/evidence/${requestId}`);
      if (!response.ok)
        await throwSupportError(response, "evidence request load");
      return Detail.parse(await response.json()).data;
    },
  });
  const submit = async () => {
    if (pending || !body.trim()) return;
    setConfirming(false);
    setPending(true);
    turnId.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/support/evidence/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          clientTurnId: turnId.current,
        }),
      });
      if (!response.ok) await throwSupportError(response, "evidence response");
      turnId.current = null;
      setBody("");
      await (query.data
        ? invalidateSupportCase(qc, query.data.caseId)
        : qc.invalidateQueries({ queryKey: supportKeys.evidence() }));
      toast({ title: "Evidence response submitted" });
    } catch (error) {
      toast({
        title: "Response was not submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };
  const data = query.data;
  if (query.isPending)
    return <output className="block">Loading evidence request…</output>;
  if (!data)
    return (
      <ErrorState
        title="Couldn't load this evidence request"
        onRetry={() => void query.refetch()}
      />
    );
  const open = !data.respondedAt && !data.cancelledAt && !data.caseClosed;
  return (
    <>
      <PageHeader
        title="Evidence request"
        back={{ href: inboxHref, label: "Evidence requests" }}
        meta={
          <StatusBadge
            label={evidenceStatus(data, "Response needed")}
            tone={open ? "caution" : "neutral"}
            size="sm"
          />
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <aside className="space-y-4 rounded-lg border border-border p-5 text-sm lg:col-start-2 lg:row-start-1">
          <h2 className="font-semibold">Request details</h2>
          {data.booking && (
            <div>
              <p className="text-xs text-muted-foreground">Appointment</p>
              <p>{data.booking.title ?? "Session"}</p>
              {data.booking.startsAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {when(data.booking.startsAt)}
                </p>
              )}
              {data.booking.organizationName && (
                <p className="text-xs text-muted-foreground">
                  {data.booking.organizationName}
                </p>
              )}
            </div>
          )}
          <div>
            <p className="text-xs text-muted-foreground">Respond by</p>
            <p>{when(data.dueAt)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Visibility</p>
            <p>
              Your response and attachments are shared with the platform
              investigation team.
            </p>
          </div>
        </aside>
        <section className="min-w-0 space-y-4 rounded-xl border border-border p-5 lg:col-start-1 lg:row-start-1">
          <h2 className="font-semibold">What we need from you</h2>
          <p className="whitespace-pre-wrap">{data.prompt}</p>
          {data.cancelledAt && (
            <output className="block">This request was cancelled.</output>
          )}
          {data.caseClosed && (
            <output className="block">The investigation has concluded.</output>
          )}
          {data.decisions.map((decision) => (
            <div
              key={decision.id}
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <p>
                {humanizeEnum(decision.outcome)}. Recorded on{" "}
                {clock.date(decision.createdAt)}.
              </p>
              {new Date(decision.appealUntil) > new Date() && (
                <AppealAction
                  target={{ decisionId: decision.id }}
                  prompt="Reason for appeal"
                />
              )}
            </div>
          ))}
          {data.responseBody && (
            <div className="whitespace-pre-wrap rounded-lg bg-muted p-4">
              <p className="mb-2 font-medium">Your submitted response</p>
              {data.responseBody}
            </div>
          )}
          {open && (
            <p
              id="evidence-final-note"
              className="rounded-md border border-dashed border-border p-3 text-sm"
            >
              Attach files before submitting; responses are final. Once you
              submit, you can&apos;t edit your response or add files.
            </p>
          )}
          <CaseAttachments
            caseId={data.caseId}
            evidenceRequestId={data.id}
            canUpload={open}
          />
          {open && (
            <>
              <label
                className="block text-sm font-medium"
                htmlFor="evidence-response"
              >
                Your response
              </label>
              <Textarea
                id="evidence-response"
                aria-describedby="evidence-final-note"
                value={body}
                maxLength={10000}
                onChange={(event) => {
                  setBody(event.target.value);
                  turnId.current = null;
                }}
              />
              <Button
                disabled={pending || !body.trim()}
                onClick={() => setConfirming(true)}
              >
                {pending ? "Submitting…" : "Submit response"}
              </Button>
              <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Submit your final response?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      You won&apos;t be able to edit it or attach more files
                      afterwards. Check that every file you want to share is
                      listed under Attachments.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep editing</AlertDialogCancel>
                    <Button disabled={pending} onClick={() => void submit()}>
                      Submit response
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </section>
      </div>
    </>
  );
}
