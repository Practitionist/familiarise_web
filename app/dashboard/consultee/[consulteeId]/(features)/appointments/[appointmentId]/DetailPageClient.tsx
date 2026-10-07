"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarPlus,
  MessageSquare,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { ConsulteeDocuments } from "@/components/appointments/detail/ConsulteeDocuments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  isDeadOccurrence,
  isOccurrenceOver,
} from "@/lib/appointments/occurrences";
import { buildIcs } from "@/lib/appointments/ics";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import {
  consultantUserIdOf,
  useConsulteeAppointmentsAdapter,
} from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

/** Sessions worth putting in a calendar: booked (not held), live, not over. */
function calendarSessions(vm: AppointmentVM) {
  return vm.occurrences.filter(
    (o) => !o.isTentative && !isDeadOccurrence(o) && !isOccurrenceOver(o),
  );
}

/** An .ics of the booking's upcoming sessions, built in the browser. */
function downloadIcs(vm: AppointmentVM) {
  const sessions = calendarSessions(vm).map((o) => ({
    id: o.occurrenceId,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
  }));
  const ics = buildIcs({
    title: vm.title,
    description: `With ${vm.counterpart.name}`,
    url: window.location.href,
    sessions,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const url = URL.createObjectURL(
    new Blob([ics], { type: "text/calendar;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${vm.title.replaceAll(/[^\w-]+/g, "-").slice(0, 60) || "session"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function hasLiveRenewal(
  renewal:
    | {
        id?: string;
        status?: string;
        deletedAt?: Date | string | null;
      }
    | null
    | undefined,
): boolean {
  if (!renewal?.id || renewal.deletedAt) return false;
  const st = renewal.status?.toUpperCase();
  return st !== "CANCELLED" && st !== "REJECTED" && st !== "EXPIRED";
}

function readSubscriptionRenewal(sub: object | null | undefined): {
  id?: string;
  status?: string;
  deletedAt?: Date | string | null;
} | null {
  if (
    !sub ||
    !("renewal" in sub) ||
    !sub.renewal ||
    typeof sub.renewal !== "object"
  ) {
    return null;
  }
  const r = sub.renewal;
  const id = "id" in r && typeof r.id === "string" ? r.id : undefined;
  const status =
    "status" in r && typeof r.status === "string" ? r.status : undefined;
  const deletedAt =
    "deletedAt" in r &&
    (typeof r.deletedAt === "string" ||
      r.deletedAt instanceof Date ||
      r.deletedAt === null)
      ? r.deletedAt
      : undefined;
  return { id, status, deletedAt };
}

function UnpaidRequestedBookingControls({
  appointmentId,
  initialNotes,
}: Readonly<{
  appointmentId: string;
  initialNotes: string;
}>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [savingNotes, setSavingNotes] = useState(false);

  useEffect(() => {
    setNotes(initialNotes);
  }, [initialNotes]);

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestNotes: notes.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to update request notes");
      }
      setEditingNotes(false);
      await queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
      toast({
        title: "Request notes updated",
        description: "Your updated note has been saved for the expert.",
      });
    } catch (err) {
      toast({
        title: "Couldn't update request notes",
        description:
          err instanceof Error ? err.message : "Please try again shortly.",
        variant: "destructive",
      });
    } finally {
      setSavingNotes(false);
    }
  };

  return (
    <div
      data-testid="unpaid-request-controls"
      className="w-full mt-2 rounded-lg border border-border bg-muted/40 p-3 text-xs space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium text-foreground">
            Unpaid booking request
          </span>
          <span className="ml-1.5 text-muted-foreground">
            — You can edit your note before the expert responds.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setEditingNotes((prev) => !prev)}
          >
            <Pencil className="mr-1 h-3 w-3" />
            {editingNotes ? "Cancel edit" : "Edit request notes"}
          </Button>
        </div>
      </div>

      {editingNotes && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Share goals, topics, or questions for your expert"
            aria-label="Request notes"
            className="h-8 flex-1 min-w-[200px] text-xs"
            maxLength={2000}
          />
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            disabled={savingNotes}
            onClick={() => void handleSaveNotes()}
          >
            {savingNotes ? "Saving…" : "Save notes"}
          </Button>
        </div>
      )}

      {!editingNotes && notes && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Your note:</span>{" "}
          {notes}
        </p>
      )}
    </div>
  );
}

function deriveConsulteeActionMeta(vm: AppointmentVM) {
  const canRebook =
    Boolean(vm.consultantProfileId) &&
    (vm.bucket === "past" || vm.bucket === "cancelled");
  const canAddToCalendar = calendarSessions(vm).length > 0;
  const expertName = vm.counterpart.name || "Expert";

  const rawAppt = vm.raw.appointment;
  const rawSub = rawAppt?.subscription ?? undefined;
  const rawConsultation = rawAppt?.consultation ?? undefined;

  const expertUserId = consultantUserIdOf(vm);

  const subscriptionPlanId =
    rawSub?.subscriptionPlan?.id ?? rawSub?.subscriptionPlanId ?? null;
  const subscriptionId = rawSub?.id ?? null;

  const canRenewSubscription =
    vm.kind === "SUBSCRIPTION" &&
    (vm.status === "APPROVED" || vm.status === "COMPLETED") &&
    !hasLiveRenewal(readSubscriptionRenewal(rawSub)) &&
    Boolean(subscriptionPlanId) &&
    Boolean(subscriptionId);

  const totalSessions =
    vm.group?.total ??
    rawSub?.sessionsTotal ??
    rawSub?.subscriptionPlan?.totalSessions ??
    vm.occurrences.filter((o) => !isDeadOccurrence(o)).length;
  const completedSessions =
    vm.group?.completed ??
    vm.occurrences.filter((o) => !isDeadOccurrence(o) && isOccurrenceOver(o))
      .length;
  const remainingSessions =
    totalSessions > 0 ? Math.max(0, totalSessions - completedSessions) : null;

  const showLowSessionRenewalNudge =
    canRenewSubscription &&
    remainingSessions !== null &&
    remainingSessions <= 1;

  const isCompletedOneOnOne =
    (vm.kind === "CONSULTATION" || vm.kind === "TRIAL") &&
    (vm.status === "COMPLETED" || vm.bucket === "past") &&
    Boolean(vm.consultantProfileId);

  const isPendingRequestEntity =
    rawConsultation?.status === "PENDING" || rawSub?.status === "PENDING";
  const isVerifiedUnpaid =
    Array.isArray(rawAppt?.payment) &&
    rawAppt.payment.every((p) => p.paymentStatus !== "SUCCEEDED");
  const isUnpaidRequested =
    (vm.kind === "CONSULTATION" || vm.kind === "SUBSCRIPTION") &&
    isPendingRequestEntity &&
    isVerifiedUnpaid;

  const initialRequestNotes =
    rawConsultation?.requestNotes ?? rawSub?.requestNotes ?? "";

  return {
    canRebook,
    canAddToCalendar,
    expertName,
    expertUserId,
    subscriptionPlanId,
    subscriptionId,
    canRenewSubscription,
    remainingSessions,
    showLowSessionRenewalNudge,
    isCompletedOneOnOne,
    isUnpaidRequested,
    initialRequestNotes,
  };
}

function ConsulteeExtraActions({
  vm,
  consulteeId,
  appointmentId,
  hasOverflowMessageAction,
}: Readonly<{
  vm: AppointmentVM;
  consulteeId: string;
  appointmentId: string;
  hasOverflowMessageAction: boolean;
}>) {
  const {
    canRebook,
    canAddToCalendar,
    expertName,
    expertUserId,
    subscriptionPlanId,
    subscriptionId,
    canRenewSubscription,
    remainingSessions,
    showLowSessionRenewalNudge,
    isCompletedOneOnOne,
    isUnpaidRequested,
    initialRequestNotes,
  } = deriveConsulteeActionMeta(vm);

  const renewalNudgeMessage =
    remainingSessions === 1
      ? `1 session left in your subscription with ${expertName}. Renew now to keep your momentum going.`
      : `You've completed all sessions in this subscription with ${expertName}. Renew to continue working together.`;

  return (
    <>
      {canAddToCalendar && (
        <Button variant="outline" size="sm" onClick={() => downloadIcs(vm)}>
          <CalendarPlus className="mr-1.5 h-4 w-4" />
          Add to calendar
        </Button>
      )}
      {expertUserId && !hasOverflowMessageAction && (
        <Button variant="outline" size="sm" asChild>
          <Link
            href={`/dashboard/consultee/${consulteeId}/messages?contextAppointmentId=${encodeURIComponent(appointmentId)}&counterpartyUserId=${encodeURIComponent(expertUserId)}`}
          >
            <MessageSquare className="mr-1.5 h-4 w-4" />
            Message {expertName}
          </Link>
        </Button>
      )}
      {canRenewSubscription && !showLowSessionRenewalNudge && (
        <Button variant="outline" size="sm" asChild>
          <Link
            href={`/checkout/plans/subscription/${subscriptionPlanId}?renewsSubscriptionId=${subscriptionId}`}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Renew Subscription
          </Link>
        </Button>
      )}
      {isCompletedOneOnOne && (
        <Button variant="default" size="sm" asChild>
          <Link href={`/explore/experts/${vm.consultantProfileId}`}>
            <ArrowRight className="mr-1.5 h-4 w-4" />
            Continue with {expertName}
          </Link>
        </Button>
      )}
      {canRebook && (
        <Button variant="outline" size="sm" asChild>
          <Link href={`/explore/experts/${vm.consultantProfileId}`}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Book again
          </Link>
        </Button>
      )}

      {showLowSessionRenewalNudge && (
        <div
          data-testid="subscription-renewal-nudge"
          className="w-full mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/80 px-3.5 py-2.5 text-xs text-amber-900"
        >
          <span>{renewalNudgeMessage}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
            <Link
              href={`/checkout/plans/subscription/${subscriptionPlanId}?renewsSubscriptionId=${subscriptionId}`}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Renew now
            </Link>
          </Button>
        </div>
      )}

      {isUnpaidRequested && (
        <UnpaidRequestedBookingControls
          appointmentId={appointmentId}
          initialNotes={initialRequestNotes}
        />
      )}

      {vm.status === "COMPLETED" && vm.consultantProfileId && (
        <div
          data-testid="public-review-followup"
          className="w-full mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5 text-xs"
        >
          <span className="text-foreground">
            Completed your session with {expertName}? Share a public review on
            their profile.
          </span>
          <Link
            href={`/explore/experts/${vm.consultantProfileId}#reviews`}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            Write a public review →
          </Link>
        </div>
      )}
    </>
  );
}

export default function DetailPageClient({
  consulteeId,
  appointmentId,
  viewerZone,
}: Readonly<{
  consulteeId: string;
  appointmentId: string;
  /** Server-read viewer zone, so SSR and hydration agree. */
  viewerZone: string;
}>) {
  const adapter = useConsulteeAppointmentsAdapter();

  return (
    <DisplayZoneProvider zone={viewerZone}>
      <AppointmentDetailClient
        appointmentId={appointmentId}
        role="consultee"
        adapter={adapter}
        backHref={`/dashboard/consultee/${consulteeId}/appointments`}
        supportRequestsBase={`/dashboard/consultee/${consulteeId}/support/requests`}
        joinWindowMs={CONSULTEE_JOIN_WINDOW_MS}
        renderExtraActions={(vm) => {
          const hasOverflowMessageAction = adapter
            .overflowItems(vm)
            .some((item) => item.key === "message");
          return (
            <ConsulteeExtraActions
              vm={vm}
              consulteeId={consulteeId}
              appointmentId={appointmentId}
              hasOverflowMessageAction={hasOverflowMessageAction}
            />
          );
        }}
        renderDocuments={(vm) => (
          <ConsulteeDocuments vm={vm} appointmentId={appointmentId} />
        )}
      />
    </DisplayZoneProvider>
  );
}
