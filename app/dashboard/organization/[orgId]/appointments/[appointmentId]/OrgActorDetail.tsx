"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
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
import { appointmentStatusBadge } from "@/lib/labels/session-labels";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

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
  isSubscription: boolean;
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

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  // Thrown messages surface inside the ConfirmDialog.
  if (!res.ok)
    throw new Error(errorMessageFromBody(json, "That didn't go through."));
  return json;
}

function RefundQuote({ appointmentId }: Readonly<{ appointmentId: string }>) {
  const quote = useQuery({
    queryKey: ["cancel-refund-preview", appointmentId],
    queryFn: async () => {
      const res = await fetch(
        `/api/appointments/${appointmentId}/cancel/preview`,
        {
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) throw new Error("Could not estimate the refund");
      return (await res.json()) as {
        estimatedRefundPaise: number;
        currency: string;
        refundPct: number;
      };
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
  if (quote.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        We couldn&apos;t estimate the refund; the cancellation policy still
        applies.
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
 * The operator view of one org appointment (#1527 §7.3, Q11): ADR 20
 * metadata for `operations.read`, and for the funding org's OWNER/MAINTAINER
 * an "Acting for <Org>" cancel and reschedule request. The server authorizes
 * both through `isOrgAdminOfAppointment` and records the human actor.
 */
export function OrgActorDetail({
  orgId,
  orgName,
  appointmentId,
  meta,
  canCancel,
  canReschedule,
  isSubscription,
}: Readonly<OrgActorDetailProps>) {
  const router = useRouter();
  const { toast } = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const acting = canCancel || canReschedule;
  const status = meta.status ? appointmentStatusBadge(meta.status) : null;

  const cancel = async () => {
    await postJson(`/api/appointments/${appointmentId}/cancel`, {
      notes: `Cancelled on behalf of ${orgName}`,
    });
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
    await postJson(url, { reason });
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
            {canReschedule && (
              <ConfirmDialog
                title="Ask to reschedule?"
                description="The current time is released and the expert picks a new one."
                confirmLabel="Ask to reschedule"
                requireReason={{ label: "Why is it moving?" }}
                onConfirm={reschedule}
                trigger={<Button variant="outline">Reschedule</Button>}
              />
            )}
            {canCancel && (
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
        <p className="text-xs text-muted-foreground">
          Organization roles see when and with whom a session happens, never
          what was shared in it.
        </p>
      </DashboardContent>
    </>
  );
}
