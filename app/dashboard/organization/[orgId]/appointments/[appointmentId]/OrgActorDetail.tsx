"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import type { AppointmentStatus, AppointmentsType } from "@prisma/client";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { KeyValueList, Section } from "@/components/dashboard/Section";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import {
  bookingStatus,
  bookingStatusBadge,
} from "@/lib/appointments/booking-status";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  CancelRefundPreviewSchema,
  type CancelRefundPreview,
} from "@/schemas/appointments";
import {
  applyRefundRequote,
  cancelPreviewQueryKey,
  cancelPreviewUrl,
  cancelRefusalFrom,
  CancelRefusedError,
  readRefundQuoteChanged,
  shownQuoteBody,
} from "@/lib/appointments/cancel-requote";
import { OperatorOpsHint } from "@/components/appointments/OperatorOpsHint";
import { AllocateOrgBookingDialog } from "../AllocateOrgBookingDialog";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import { createSubmissionKeys } from "@/lib/api/submission-key";

export interface OrgActorDetailProps {
  orgId: string;
  orgName: string;
  appointmentId: string;
  meta: {
    title: string;
    kind: AppointmentsType;
    status: AppointmentStatus | null;
    expertName: string | null;
    learnerName: string | null;
    sessions: { id: string; startsAt: Date; endsAt: Date | null }[];
  };
  canCancel: boolean;
  canReschedule: boolean;
  canAllocate?: boolean;
  isSubscription: boolean;
  /** Set for a platform operator, who reschedules and cancels from the back office instead. */
  opsHref?: string | null;
}

const fmt = (d: Date) =>
  new Date(d).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetchWithIdentity(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(errorMessageFromBody(json, "That didn't go through."));
  return json;
}

function RefundQuote({ appointmentId }: Readonly<{ appointmentId: string }>) {
  const url = cancelPreviewUrl(appointmentId);
  const quote = useQuery<CancelRefundPreview>({
    queryKey: cancelPreviewQueryKey(url),
    queryFn: async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) {
        const refusal = cancelRefusalFrom(await res.json().catch(() => null));
        throw refusal ?? new Error("Could not estimate the refund");
      }
      const parsed = CancelRefundPreviewSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Could not estimate the refund");
      return parsed.data;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (quote.isPending) {
    return (
      <p className="text-sm text-muted-foreground">Estimating the refund…</p>
    );
  }
  if (quote.error instanceof CancelRefusedError) {
    return <p className="text-sm text-destructive">{quote.error.message}</p>;
  }
  if (quote.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        We couldn&apos;t estimate the refund; the cancellation policy still
        applies.
      </p>
    );
  }
  if (quote.data.paid === false) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing was paid for this booking, so there is nothing to refund.
      </p>
    );
  }
  return (
    <p className="text-sm">
      Estimated refund:{" "}
      <span className="font-medium">
        {formatCurrencyAmount(
          quote.data.estimatedRefundPaise,
          quote.data.currency,
        )}
      </span>{" "}
      ({quote.data.refundPct}%).
    </p>
  );
}

/**
 * The operator view of one org appointment: metadata for `operations.read`,
 * and for the funding org's authorized operators an "Acting for <Org>"
 * slot allocation, reschedule request, and cancellation.
 */
export function OrgActorDetail({
  orgId,
  orgName,
  appointmentId,
  meta,
  canCancel,
  canReschedule,
  canAllocate = false,
  isSubscription,
  opsHref = null,
}: Readonly<OrgActorDetailProps>) {
  const router = useRouter();
  const { toast } = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rescheduleKeyFor] = useState(createSubmissionKeys);
  const showAllocate = Boolean(canAllocate);
  const acting = ((canCancel || canReschedule) && !opsHref) || showAllocate;
  const status = meta.status
    ? bookingStatusBadge(
        bookingStatus({ kind: meta.kind, status: meta.status }, "ORG_ADMIN"),
      )
    : null;

  const queryClient = useQueryClient();
  const cancel = async () => {
    // The click carries the quote the dialog showed; a different server quote
    // answers 409 with the new figure, which re-renders the dialog.
    const previewUrl = cancelPreviewUrl(appointmentId);
    const shown = queryClient.getQueryData<CancelRefundPreview>(
      cancelPreviewQueryKey(previewUrl),
    );
    const res = await fetchWithIdentity(
      `/api/appointments/${appointmentId}/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: `Cancelled on behalf of ${orgName}`,
          ...shownQuoteBody(
            shown && shown.paid !== false
              ? {
                  estimatedRefundPaise: shown.estimatedRefundPaise,
                  creditRestoresInFull: shown.creditRestoresInFull,
                  expectedPaid: shown.expectedPaid,
                }
              : undefined,
          ),
        }),
      },
    );
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const requote = res.status === 409 ? readRefundQuoteChanged(json) : null;
      if (requote) {
        applyRefundRequote(queryClient, previewUrl, requote);
        throw new Error(
          "The refund has changed. Check the new amount and confirm again.",
        );
      }
      throw new Error(errorMessageFromBody(json, "That didn't go through."));
    }
    toast({
      title: "Booking cancelled",
      description: `Cancelled for ${orgName}.`,
    });
    router.refresh();
  };

  const reschedule = async ({ reason }: { reason?: string }) => {
    const url = isSubscription
      ? `/api/appointments/${appointmentId}/reschedule?type=SUBSCRIPTION`
      : `/api/appointments/${appointmentId}/reschedule`;
    const body = { reason };
    // Keyed on the whole request and the times it releases, so a later move of
    // the same booking never replays an earlier answer.
    const key = rescheduleKeyFor({
      url,
      body,
      releases: meta.sessions.map((s) => [
        s.id,
        new Date(s.startsAt).getTime(),
      ]),
    });
    await postJson(url, body, { "Idempotency-Key": key });
    toast({
      title: "Reschedule requested",
      description: "The expert will pick a new time.",
    });
    router.refresh();
  };

  return (
    <>
      <DashboardHeader
        title={meta.title}
        description={`${humanizeEnum(meta.kind)} under ${orgName}`}
        back={{
          href: `/dashboard/organization/${orgId}/appointments?tab=everyone`,
          label: "Appointments",
        }}
      />
      <DashboardContent>
        {acting && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm">
            <Building2 className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <span className="font-medium">Acting for {orgName}.</span> Changes
              you make here are recorded under your name as the
              organization&apos;s decision, and the attendee and expert are
              notified.
            </p>
          </div>
        )}

        <Section variant="card">
          <KeyValueList
            items={[
              {
                label: "Status",
                value: status ? <StatusBadge {...status} /> : "—",
              },
              { label: "Expert", value: meta.expertName ?? "—" },
              { label: "Attendee", value: meta.learnerName ?? "—" },
              {
                label: "Sessions",
                value:
                  meta.sessions.length === 0
                    ? "Not scheduled yet"
                    : meta.sessions.map((s) => fmt(s.startsAt)).join(" · "),
              },
            ]}
          />
        </Section>

        {acting && (
          <div className="flex flex-wrap gap-2">
            {showAllocate && (
              <AllocateOrgBookingDialog
                orgId={orgId}
                appointmentId={appointmentId}
                planTitle={meta.title}
                expertName={meta.expertName}
                learnerName={meta.learnerName}
              />
            )}
            {canReschedule && !opsHref && (
              <ConfirmDialog
                title="Ask to reschedule?"
                description="The current time is released and the expert picks a new one."
                confirmLabel="Ask to reschedule"
                requireReason={{ label: "Why is it moving?" }}
                onConfirm={reschedule}
                trigger={<Button variant="outline">Reschedule</Button>}
              />
            )}
            {canCancel && !opsHref && (
              <ConfirmDialog
                open={cancelOpen}
                onOpenChange={setCancelOpen}
                title="Cancel this booking?"
                description="The booking ends for everyone on it. Any refund follows the cancellation policy and goes back to how it was paid."
                confirmLabel="Cancel booking"
                cancelLabel="Keep booking"
                tone="destructive"
                onConfirm={cancel}
                trigger={<Button variant="destructive">Cancel booking</Button>}
              >
                {cancelOpen && <RefundQuote appointmentId={appointmentId} />}
              </ConfirmDialog>
            )}
          </div>
        )}
        {opsHref && (canCancel || canReschedule) && (
          <OperatorOpsHint href={opsHref} />
        )}
        <p className="text-xs text-muted-foreground">
          Organization roles see when and with whom a session happens, never
          what was shared in it.
        </p>
      </DashboardContent>
    </>
  );
}
