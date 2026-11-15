"use client";

/**
 * Participant roster for a group session — one route for webinars and classes.
 *
 * A class carries `appointments: Appointment[]` while a webinar carries a
 * single `appointment | null`, so the two are narrowed rather than cast and
 * the appointment list is normalised before the participant flattening.
 */

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TableSkeleton } from "@/components/dashboard/DashboardSkeletons";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import {
  RemoveParticipantDialog,
  type RemovalChoice,
} from "@/components/events/RemoveParticipantDialog";
import { effectiveMaxParticipants } from "@/lib/events/capacity";
import { formatCurrencyAmount } from "@/utils/formatting";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { participantStatusBadge } from "@/lib/labels/session-labels";
import { seatPaymentBadge } from "@/lib/appointments/seat-payments";

import type { ClassEvent, WebinarEvent } from "@/types/planner-events";

/** URL segment → API path segment and the noun used in the count line. */
const EVENT_KINDS = {
  webinars: { apiSegment: "webinar", countNoun: "registered" },
  classes: { apiSegment: "class", countNoun: "participants" },
} as const;

type EventKind = keyof typeof EVENT_KINDS;

/**
 * The two responses differ in more than naming: a class carries
 * `appointments: Appointment[]`, a webinar a single `appointment | null`.
 * Narrowing on the key rather than casting keeps that difference honest.
 */
/** One row per seat that has a Payment; a seat with none is unpaid. */
type SeatPayment = {
  userId: string;
  paymentStatus: string;
  amount: string;
  currency: string;
};

// Registered-participant rows are the route's roster (#1554): every live seat
// holder on the event's appointment(s), deduplicated by user id server-side.
// The seat's own status rides along: `liveParticipant()` already drops released
// seats, so what survives is HELD/CONFIRMED/ATTENDED — and a host cannot tell
// a held seat from a paid one without it. `null` means the person appears on
// the roster without holding a seat (an approved request that never booked).
type RegisteredParticipant = {
  id: string;
  name?: string;
  email?: string;
  participantStatus?: string | null;
  participantRole?: string | null;
};

type ParticipantsResponse = (
  | { webinarEvent: WebinarEvent; classEvent?: never }
  | { classEvent: ClassEvent; webinarEvent?: never }
) & {
  participants?: RegisteredParticipant[];
  seatPayments?: SeatPayment[];
  /** Open notify-me rows; a count, never names. */
  waitingCount?: number;
};

/**
 * What the DELETE handler answers (#1003). `refund` is null when the seat was
 * never paid for, and `{ amountRefundedPaise: 0 }` when the policy tier
 * returned nothing — two different facts the toast has to keep apart.
 */
type RemoveParticipantResult = {
  removed: boolean;
  refund: {
    amountRefundedPaise: number;
    refundPct: number;
    /** Null when nothing moved. See the toast: only GATEWAY reaches them. */
    rail?: "GATEWAY" | "INTERNAL" | "CREDITS" | null;
    /** The seat was free: nothing was paid, so nothing was refunded. */
    freeBooking?: true;
  } | null;
};

const fetchParticipants = async (
  apiSegment: string,
  eventId: string,
): Promise<ParticipantsResponse> => {
  const response = await fetch(`/api/participants/${apiSegment}/${eventId}`);
  if (!response.ok) throw new Error("Failed to fetch event data");
  return response.json();
};

/** A removal the server refused with nothing changed; its sentence is for the host. */
class RemovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemovalRefusedError";
  }
}

const FREE_SEAT_LINE = "Their seat was free, so there is nothing to refund.";

const refusalBody = z.object({ error: z.string().min(1) });

const removeParticipant = async ({
  apiSegment,
  eventId,
  userId,
}: {
  apiSegment: string;
  eventId: string;
  userId: string;
}): Promise<RemoveParticipantResult> => {
  const response = await fetch(
    `/api/participants/${apiSegment}/${eventId}?userId=${userId}`,
    { method: "DELETE" },
  );
  // A 4xx with a sentence is a refusal: the server changed nothing.
  if (response.status >= 400 && response.status < 500) {
    const body = refusalBody.safeParse(await response.json().catch(() => null));
    if (body.success) throw new RemovalRefusedError(body.data.error);
  }
  if (!response.ok) throw new Error("Failed to remove participant");
  // Only the class and webinar handlers are reachable (EVENT_KINDS admits no
  // others) and both answer JSON — a refund summary since #1003. Both also
  // answer 200 for an already-removed participant, so a repeat click still
  // invalidates the roster rather than surfacing a failure.
  return response.json();
};

/** What the conduct removal answers: the support case it opened for the attendee. */
const conductRemovalResult = z.object({
  removed: z.boolean(),
  caseReference: z.string().optional(),
  earningsHeld: z.boolean().optional(),
});

const removeForConduct = async ({
  apiSegment,
  eventId,
  userId,
  choice,
}: {
  apiSegment: string;
  eventId: string;
  userId: string;
  choice: Extract<RemovalChoice, { mode: "CONDUCT" }>;
}) => {
  const response = await fetch(
    `/api/participants/${apiSegment}/${eventId}/remove`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetUserId: userId,
        reason: choice.reason,
        note: choice.note,
      }),
    },
  );
  if (!response.ok) {
    const body = refusalBody.safeParse(await response.json().catch(() => null));
    throw new Error(
      body.success ? body.data.error : "We couldn't remove them. Try again.",
    );
  }
  return conductRemovalResult.parse(await response.json());
};

export default function EventParticipantsPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // The person the confirm dialog is about; null closes it.
  const [pendingRemoval, setPendingRemoval] =
    useState<RegisteredParticipant | null>(null);

  const eventType = params.eventType as string;
  const eventId = params.eventId as string;
  const kind = EVENT_KINDS[eventType as EventKind];

  const { data, isLoading, error } = useQuery({
    queryKey: ["event-participants", eventType, eventId],
    queryFn: () => fetchParticipants(kind.apiSegment, eventId),
    enabled: !!eventId && !!kind,
    // Roster reads are invalidated on remove; a short stale window dedupes
    // remount refetches in between.
    staleTime: 2 * 60_000,
  });

  const removeParticipantMutation = useMutation({
    mutationFn: removeParticipant,
    // The organiser is told what actually happened to the money, not a generic
    // "removed". A removal issues a refund server-side and used to say so
    // nowhere at all — the response was explicitly discarded.
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["event-participants", eventType, eventId],
      });
      let description: string;
      if (!result.removed) {
        description = "They were already off the roster — nothing changed.";
      } else if (!result.refund) {
        description =
          "No payment was found for this seat, so nothing was refunded.";
      } else if (result.refund.freeBooking) {
        description = FREE_SEAT_LINE;
      } else if (result.refund.amountRefundedPaise > 0) {
        // INR: settlement is INR-only by design, and the refund summary
        // carries no currency of its own.
        const amount = formatCurrencyAmount(
          result.refund.amountRefundedPaise,
          "INR",
        );
        const pct = `${result.refund.refundPct}% of the seat`;
        // Only the gateway rail reaches the attendee. An org-funded seat
        // returns to the sponsor's wallet/accrual/licence and a credit-funded
        // one to the buyer's referral balance — telling the organiser it lands
        // on a card in 5–7 working days was false on both.
        if (result.refund.rail === "INTERNAL") {
          description = `${amount} (${pct}) went back to the sponsoring organisation's balance; nothing was charged to them.`;
        } else if (result.refund.rail === "CREDITS") {
          description = `${amount} (${pct}) was restored to their referral credit balance.`;
        } else {
          description = `${amount} refunded (${pct}). It reaches them in 5–7 working days.`;
        }
      } else {
        description = `No refund was due under the cancellation policy (${result.refund.refundPct}%).`;
      }
      toast({ title: "Participant removed", description });
    },
    onError: (err, variables) => {
      // A refusal committed nothing: say why, and keep them listed.
      if (err instanceof RemovalRefusedError) {
        toast({
          title: "Couldn't remove them yet",
          description: err.message,
          variant: "destructive",
        });
        return;
      }
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "client" } },
      );
      console.error("Error removing participant:", err);
      // A lost response is not proof of a lost write: the DELETE may have
      // disconnected the attendee AND issued their refund before the
      // connection dropped. "Nothing was changed and no refund was issued" was
      // the one claim this handler cannot support, and a retry cannot recover
      // the original refund result either — it would answer `removed: false`.
      // Refresh the roster instead, and say only what is actually known.
      queryClient.invalidateQueries({
        queryKey: ["event-participants", eventType, eventId],
      });
      toast({
        title: "Could not confirm the removal",
        description:
          "We couldn't confirm whether they were removed or refunded. The roster has been refreshed — try again if they're still listed.",
        variant: "destructive",
        action: (
          <ToastAction
            altText="Retry removing this participant"
            onClick={() => removeParticipantMutation.mutate(variables)}
          >
            Retry
          </ToastAction>
        ),
      });
    },
  });

  // Errors stay inside the dialog, so this mutation toasts only on success.
  const conductRemovalMutation = useMutation({
    mutationFn: removeForConduct,
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["event-participants", eventType, eventId],
      });
      toast({
        title: result.removed ? "Participant removed" : "Already removed",
        description: result.removed
          ? `They were told why. Support case ${result.caseReference ?? ""} reviews the removal and decides within 72 hours${
              result.earningsHeld
                ? ", and your earnings from this seat are held until it decides"
                : ""
            }.`
          : "They were already off the roster, so nothing changed.",
      });
    },
  });

  // Only webinars and classes have a roster worth managing. Anything else in
  // the URL is a hand-edit or a stale link.
  if (!kind) notFound();

  const handleRemoval = async (choice: RemovalChoice) => {
    if (!pendingRemoval) return;
    if (choice.mode === "NO_FAULT") {
      // Fire and close: the mutation's own toast reports the refund or a failure.
      removeParticipantMutation.mutate({
        apiSegment: kind.apiSegment,
        eventId,
        userId: pendingRemoval.id,
      });
      return;
    }
    await conductRemovalMutation.mutateAsync({
      apiSegment: kind.apiSegment,
      eventId,
      userId: pendingRemoval.id,
      choice,
    });
  };

  if (isLoading) return <TableSkeleton />;
  if (error) {
    return (
      <Card className="mt-6">
        <CardContent className="py-10 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load this roster.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: ["event-participants", eventType, eventId],
              })
            }
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const event = data?.webinarEvent ?? data?.classEvent;
  if (!event) return <div>Event not found</div>;

  const plan = "webinarPlan" in event ? event.webinarPlan : event.classPlan;

  const participants: RegisteredParticipant[] = data?.participants ?? [];

  // The instance may override the plan's capacity.
  const effectiveCapacity = effectiveMaxParticipants(event, plan);

  const seatPayments = new Map(
    (data?.seatPayments ?? []).map((p) => [p.userId, p] as const),
  );

  const registeredColumns: ResponsiveColumn<RegisteredParticipant>[] = [
    { key: "name", header: "Name", primary: true, cell: (p) => p.name },
    { key: "email", header: "Email", cell: (p) => p.email },
    {
      key: "seat",
      header: "Seat",
      // The seat, not the money: a held seat is a promise the host has made to
      // someone who has not paid yet, and "Payment: No payment" alone reads as
      // a free ticket rather than an unpaid hold.
      cell: (p) =>
        p.participantStatus === null ? (
          <span className="text-xs text-muted-foreground">No seat</span>
        ) : p.participantStatus ? (
          <StatusBadge
            {...participantStatusBadge(p.participantStatus)}
            size="sm"
          />
        ) : (
          <span className="text-xs text-muted-foreground">Unknown</span>
        ),
    },
    {
      key: "payment",
      header: "Payment",
      // The seat's payment, not a hard-coded "Registered": the host's
      // question here is "did this person pay", and a seat with no Payment
      // row (a free event, an org-sponsored seat) says so rather than
      // pretending.
      cell: (p) => {
        const seat = seatPayments.get(p.id);
        if (!seat) {
          return (
            <span className="text-xs text-muted-foreground">No payment</span>
          );
        }
        return (
          <span className="inline-flex items-center gap-2">
            <StatusBadge {...seatPaymentBadge(seat)} size="sm" />
            {/* A free seat says "Free" alone, never an amount of nothing. */}
            {Number(seat.amount) > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatCurrencyAmount(Number(seat.amount), seat.currency)}
              </span>
            )}
          </span>
        );
      },
    },
  ];

  // A seat on a free event with nothing paid owes nothing; the dialog says so before the click.
  const pendingSeat = pendingRemoval
    ? seatPayments.get(pendingRemoval.id)
    : undefined;
  const removingFreeSeat =
    plan.price === 0 && (!pendingSeat || Number(pendingSeat.amount) === 0);

  const renderRegisteredActions = (participant: RegisteredParticipant) => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setPendingRemoval(participant)}
      disabled={
        removeParticipantMutation.isPending || conductRemovalMutation.isPending
      }
    >
      {removeParticipantMutation.isPending || conductRemovalMutation.isPending
        ? "Removing..."
        : "Remove"}
    </Button>
  );

  return (
    <>
      <DashboardHeader
        title={`${plan.title} — Participants`}
        subtitle={`${participants.length}/${effectiveCapacity} ${kind.countNoun}${
          participants.length >= effectiveCapacity ? " · sold out" : ""
        }${data?.waitingCount ? ` · ${data.waitingCount} waiting` : ""}`}
        actions={
          <Link
            href={`/dashboard/consultant/${params.consultantId}/appointments`}
            passHref
          >
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Appointments
            </Button>
          </Link>
        }
      />
      <Card className="mt-6">
        <CardContent className="pt-6">
          <ResponsiveTable<RegisteredParticipant>
            columns={registeredColumns}
            rows={participants}
            getRowId={(p) => p.id}
            rowActions={renderRegisteredActions}
            empty={
              <div className="py-8 text-center text-muted-foreground">
                No registered participants yet.
              </div>
            }
          />
        </CardContent>
      </Card>

      <RemoveParticipantDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        attendeeName={pendingRemoval?.name ?? null}
        eventTitle={plan.title}
        allowNoFault
        freeSeat={removingFreeSeat}
        onSubmit={handleRemoval}
      />
    </>
  );
}
