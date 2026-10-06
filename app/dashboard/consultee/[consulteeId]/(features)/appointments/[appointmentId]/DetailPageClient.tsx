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
  Star,
  Trash2,
} from "lucide-react";
import { z } from "zod";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { ConsulteeDocuments } from "@/components/appointments/detail/ConsulteeDocuments";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  bookingFeedbackKey,
  useSessionFeedback,
} from "@/hooks/useSessionFeedback";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  isDeadOccurrence,
  isOccurrenceOver,
} from "@/lib/appointments/occurrences";
import { buildIcs } from "@/lib/appointments/ics";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

const consultantProfileMetaSchema = z
  .object({
    id: z.string().optional(),
    userId: z.string().optional(),
    user: z
      .object({
        id: z.string().optional(),
        name: z.string().nullable().optional(),
      })
      .optional(),
  })
  .optional();

const rawAppointmentMetaSchema = z
  .object({
    appointment: z
      .object({
        consultation: z
          .object({
            id: z.string().optional(),
            status: z.string().optional(),
            requestNotes: z.string().nullable().optional(),
            consultationPlan: z
              .object({
                id: z.string().optional(),
                consultantProfile: consultantProfileMetaSchema,
              })
              .optional(),
          })
          .nullable()
          .optional(),
        subscription: z
          .object({
            id: z.string().optional(),
            status: z.string().optional(),
            requestNotes: z.string().nullable().optional(),
            subscriptionPlanId: z.string().optional(),
            sessionsTotal: z.number().nullable().optional(),
            remainingSessions: z.number().nullable().optional(),
            subscriptionPlan: z
              .object({
                id: z.string().optional(),
                totalSessions: z.number().optional(),
                consultantProfile: consultantProfileMetaSchema,
              })
              .optional(),
          })
          .nullable()
          .optional(),
        webinar: z
          .object({
            webinarPlan: z
              .object({
                consultantProfile: consultantProfileMetaSchema,
              })
              .optional(),
          })
          .nullable()
          .optional(),
        class: z
          .object({
            classPlan: z
              .object({
                consultantProfile: consultantProfileMetaSchema,
              })
              .optional(),
          })
          .nullable()
          .optional(),
        trial: z
          .object({
            subscriptionPlanId: z.string().optional(),
            subscriptionPlan: z
              .object({
                id: z.string().optional(),
                consultantProfile: consultantProfileMetaSchema,
              })
              .optional(),
          })
          .nullable()
          .optional(),
        payment: z
          .array(
            z.object({
              paymentStatus: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const vmExtraSchema = z
  .object({
    planId: z.string().nullable().optional(),
    sourceId: z.string().nullable().optional(),
    expertUserId: z.string().nullable().optional(),
    remainingSessions: z.number().nullable().optional(),
    requestNotes: z.string().nullable().optional(),
  })
  .passthrough();

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

function resolveFeedbackSlotContext(
  feedback: ReturnType<typeof useSessionFeedback>,
  vm: AppointmentVM,
) {
  const rateableSlotIds = [...feedback.rateable];
  const ratedSlotIds = Object.keys(feedback.ratings);
  const targetOccurrenceId =
    rateableSlotIds[0] ??
    ratedSlotIds[0] ??
    vm.occurrences.find((o) => !isDeadOccurrence(o) && isOccurrenceOver(o))
      ?.occurrenceId;

  const slotRating = targetOccurrenceId
    ? feedback.ratings[targetOccurrenceId]
    : undefined;
  const existingRating =
    slotRating ?? Object.values(feedback.ratings)[0] ?? null;

  const slotComment = targetOccurrenceId
    ? feedback.comments?.[targetOccurrenceId]
    : undefined;
  const existingComment = slotComment ?? feedback.comments?.booking ?? "";

  return { targetOccurrenceId, existingRating, existingComment };
}

function ConsulteeSessionRatingFollowUp({
  appointmentId,
  vm,
}: Readonly<{
  appointmentId: string;
  vm: AppointmentVM;
}>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const feedback = useSessionFeedback(appointmentId);
  const expertName = vm.counterpart.name || "your expert";

  const { targetOccurrenceId, existingRating, existingComment } =
    resolveFeedbackSlotContext(feedback, vm);

  const [rating, setRating] = useState<number>(
    existingRating ? Math.round(existingRating) : 0,
  );
  const [comment, setComment] = useState<string>(existingComment);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (existingRating !== null) {
      setRating(Math.round(existingRating));
    }
  }, [existingRating]);

  useEffect(() => {
    if (existingComment) {
      setComment(existingComment);
    }
  }, [existingComment]);

  const highestRating = Math.max(rating, ...Object.values(feedback.ratings), 0);
  const canRateAny =
    feedback.rateable.size > 0 ||
    existingRating !== null ||
    vm.status === "COMPLETED" ||
    vm.bucket === "past";

  if (!canRateAny) return null;

  const isBusy = saving || Boolean(feedback.isSubmitting);

  const handleSubmit = async () => {
    if (rating < 1 || rating > 5) return;
    setSaving(true);
    try {
      const trimmedComment = comment.trim();
      if (feedback.submitFeedback) {
        await feedback.submitFeedback({
          rating,
          comment: trimmedComment,
          occurrenceId: targetOccurrenceId,
        });
      } else {
        const payload = targetOccurrenceId
          ? {
              rating,
              occurrenceId: targetOccurrenceId,
              comment: trimmedComment,
            }
          : { rating, comment: trimmedComment };
        const res = await fetch(`/api/appointments/${appointmentId}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Failed to save session feedback");
        await queryClient.invalidateQueries({
          queryKey: bookingFeedbackKey(appointmentId),
        });
      }
      setEditing(false);
      toast({
        title: "Feedback saved",
        description: "Your private session feedback has been recorded.",
      });
    } catch {
      toast({
        title: "Couldn't save feedback",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="consultee-session-rating-row"
      className="w-full mt-2 rounded-lg border border-border bg-muted/40 p-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">
            Private session feedback:
          </span>
          <div
            className="flex items-center gap-0.5"
            role="group"
            aria-label="Session star rating"
          >
            {[1, 2, 3, 4, 5].map((star) => {
              const starClass =
                star <= rating
                  ? "fill-amber-400 text-amber-500"
                  : "text-muted-foreground/40";
              return (
                <button
                  key={star}
                  type="button"
                  aria-label={`Rate ${star} star${star === 1 ? "" : "s"}`}
                  onClick={() => {
                    setRating(star);
                    setEditing(true);
                  }}
                  className="p-0.5 text-amber-500 hover:scale-110 transition-transform"
                >
                  <Star className={`h-4 w-4 ${starClass}`} />
                </button>
              );
            })}
          </div>
        </div>
        {!editing && existingComment && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Edit note
          </button>
        )}
      </div>

      {(editing || (rating > 0 && !existingRating)) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a private note about this session (optional)"
            aria-label="Private session feedback comment"
            className="h-8 flex-1 min-w-[200px] text-xs"
            maxLength={2000}
          />
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            disabled={isBusy || rating < 1}
            onClick={() => void handleSubmit()}
          >
            {isBusy ? "Saving…" : "Save feedback"}
          </Button>
        </div>
      )}

      {!editing && existingComment && (
        <p className="mt-1.5 text-muted-foreground italic">
          &ldquo;{existingComment}&rdquo;
        </p>
      )}

      {highestRating >= 4 && vm.consultantProfileId && (
        <p
          data-testid="public-review-followup"
          className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300"
        >
          Glad it went well!{" "}
          <Link
            href={`/explore/experts/${vm.consultantProfileId}#reviews`}
            className="font-semibold underline underline-offset-4"
          >
            Share a public review for {expertName} →
          </Link>
        </p>
      )}
    </div>
  );
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
  const [withdrawing, setWithdrawing] = useState(false);
  const [confirmWithdrawOpen, setConfirmWithdrawOpen] = useState(false);

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

  const handleWithdrawRequest = async () => {
    setConfirmWithdrawOpen(false);
    setWithdrawing(true);
    try {
      const res = await fetch(`/api/bookings/${appointmentId}/abandon`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to withdraw request");
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["appointment-detail", appointmentId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["consultee-events"],
        }),
      ]);
      toast({
        title: "Request withdrawn",
        description: "Your unpaid booking request has been cancelled.",
      });
    } catch (err) {
      toast({
        title: "Couldn't withdraw request",
        description:
          err instanceof Error ? err.message : "Please try again shortly.",
        variant: "destructive",
      });
    } finally {
      setWithdrawing(false);
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
            — You can edit your note or withdraw this request before the expert
            responds.
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
          <AlertDialog
            open={confirmWithdrawOpen}
            onOpenChange={setConfirmWithdrawOpen}
          >
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"
                disabled={withdrawing}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                {withdrawing ? "Withdrawing…" : "Withdraw request"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Withdraw booking request?</AlertDialogTitle>
                <AlertDialogDescription>
                  Withdraw this booking request? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={withdrawing}>
                  Keep request
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={withdrawing}
                  onClick={() => void handleWithdrawRequest()}
                >
                  Confirm withdrawal
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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

  const parsedVmExtra = vmExtraSchema.safeParse(vm);
  const vmExtra = parsedVmExtra.success ? parsedVmExtra.data : undefined;

  const parsedRaw = rawAppointmentMetaSchema.safeParse(vm.raw);
  const rawAppt = parsedRaw.success ? parsedRaw.data.appointment : undefined;
  const rawSub = rawAppt?.subscription ?? undefined;
  const rawConsultation = rawAppt?.consultation ?? undefined;
  const rawTrial = rawAppt?.trial ?? undefined;

  const consultantProfile =
    rawConsultation?.consultationPlan?.consultantProfile ??
    rawSub?.subscriptionPlan?.consultantProfile ??
    rawAppt?.webinar?.webinarPlan?.consultantProfile ??
    rawAppt?.class?.classPlan?.consultantProfile ??
    rawTrial?.subscriptionPlan?.consultantProfile;

  const expertUserId =
    vmExtra?.expertUserId ??
    consultantProfile?.user?.id ??
    consultantProfile?.userId ??
    null;

  const subscriptionPlanId =
    vmExtra?.planId ??
    rawSub?.subscriptionPlan?.id ??
    rawSub?.subscriptionPlanId ??
    null;
  const subscriptionId = vmExtra?.sourceId ?? rawSub?.id ?? null;
  const canRenewSubscription =
    vm.kind === "SUBSCRIPTION" &&
    (vm.status === "APPROVED" ||
      vm.status === "SCHEDULED" ||
      vm.status === "COMPLETED") &&
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
  const computedRemaining =
    totalSessions > 0 ? Math.max(0, totalSessions - completedSessions) : null;
  const remainingSessions =
    vmExtra?.remainingSessions ??
    rawSub?.remainingSessions ??
    computedRemaining;

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
    vmExtra?.requestNotes ??
    rawConsultation?.requestNotes ??
    rawSub?.requestNotes ??
    "";

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
}: Readonly<{
  vm: AppointmentVM;
  consulteeId: string;
  appointmentId: string;
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
      {expertUserId && (
        <Button variant="outline" size="sm" asChild>
          <Link
            href={`/dashboard/consultee/${consulteeId}/messages?dmTargetUserId=${encodeURIComponent(expertUserId)}&contextAppointmentId=${encodeURIComponent(appointmentId)}`}
          >
            <MessageSquare className="mr-1.5 h-4 w-4" />
            Message {expertName}
          </Link>
        </Button>
      )}
      {canRenewSubscription && (
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

      <ConsulteeSessionRatingFollowUp appointmentId={appointmentId} vm={vm} />
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
        renderExtraActions={(vm) => (
          <ConsulteeExtraActions
            vm={vm}
            consulteeId={consulteeId}
            appointmentId={appointmentId}
          />
        )}
        renderDocuments={(vm) => (
          <ConsulteeDocuments vm={vm} appointmentId={appointmentId} />
        )}
      />
    </DisplayZoneProvider>
  );
}
