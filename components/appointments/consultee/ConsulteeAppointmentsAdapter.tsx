"use client";

import { useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { useParams, useRouter } from "next/navigation";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";


import { useToast } from "@/hooks/use-toast";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import type { SlotOfAppointment } from "@prisma/client";
import type {
  AppointmentActionAdapter,
  OverflowItem,
  PrimaryAction,
} from "@/lib/appointments/adapter";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getJoinableSlot,
} from "@/lib/appointments/slots";
import {
  isApprovedStatus,
  isConfirmedStatus,
  isInactiveStatus,
  isPendingPaymentStatus,
} from "@/lib/appointments/status";
import type {
  AppointmentVM,
  SlotLike,
} from "@/lib/appointments/view-model";
import { useEventActions } from "@/components/appointments/consultee/useEventActions";
import { RescheduleSessionsModal } from "@/components/appointments/consultee/RescheduleSessionsModal";
import { useSession } from "@/lib/auth-client";
import { CancelConfirmationDialog } from "@/components/appointments/consultee/CancelConfirmationDialog";
import { ReportIssueDialog } from "@/components/appointments/consultee/ReportIssueDialog";
import { DocumentUpload } from "@/components/appointments/DocumentUpload";

type DialogKind =
  | "cancel"
  | "reschedule-multi"
  | "report"
  | "documents";

const KIND_TO_TYPE: Record<
  AppointmentVM["kind"],
  "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial"
> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
};

const KIND_TO_REPORT_TYPE: Record<
  AppointmentVM["kind"],
  "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS"
> = {
  CONSULTATION: "CONSULTATION",
  // Trials belong to subscription plans — the support flow has no TRIAL kind.
  TRIAL: "SUBSCRIPTION",
  SUBSCRIPTION: "SUBSCRIPTION",
  WEBINAR: "WEBINAR",
  CLASS: "CLASS",
};

export function useConsulteeAppointmentsAdapter(): AppointmentActionAdapter {
  const router = useRouter();
  const { toast } = useToast();
  const client = useStreamVideoClient();
  const params = useParams<{ consulteeId: string }>();
  const consulteeId = params?.consulteeId;
  // The viewer's USER id (not the consultee-profile id in the route) — the
  // availability grid keys occupancy off slot participation, and the route's
  // `isSelf` gate compares against session.user.id.
  const { data: session } = useSession();

  // ONE set of dialogs, keyed off the row that opened them.
  const [activeVm, setActiveVm] = useState<AppointmentVM | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const typeLabel = activeVm ? KIND_TO_TYPE[activeVm.kind] : "Consultation";
  const actions = useEventActions({
    appointmentId: activeVm?.appointmentId ?? undefined,
    appointment: activeVm?.raw.appointment,
    rawSlots: (activeVm?.raw.rawSlots ?? []) as SlotOfAppointment[],
    title: activeVm?.title ?? "",
    consultant: activeVm?.counterpart.name ?? "",
    type: typeLabel,
  });

  const closeDialog = () => setDialog(null);
  const openDialog = (vm: AppointmentVM, kind: DialogKind) => {
    setActiveVm(vm);
    setDialog(kind);
  };

  // Join can't go through useEventActions — its args follow activeVm state,
  // which wouldn't be committed yet on a same-click join from a row.
  const joinNow = async (vm: AppointmentVM, slot: SlotLike) => {
    if (!client) {
      toast({
        title: "Not signed in",
        description:
          "Video client not initialized. Please sign in to join the meeting.",
        variant: "destructive",
      });
      return;
    }
    const appointment = vm.raw.appointment;
    if (!appointment) {
      toast({
        title: "Unable to join",
        description: "Meeting information is not available.",
        variant: "destructive",
      });
      return;
    }
    setJoiningId(vm.id);
    try {
      // MeetingSlot is Date|string tolerant by design — pass the slot
      // honestly instead of asserting a Prisma type it isn't.
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointment,
        {
          id: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt ?? null,
          isTentative: slot.isTentative,
          appointmentId: slot.appointmentId ?? null,
        },
      );
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      Sentry.captureException(error);
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive",
      });
      setJoiningId(null);
    }
  };

  const isDev = process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";

  const primaryAction = (vm: AppointmentVM): PrimaryAction => {
    const joinable = getJoinableSlot(vm.raw.rawSlots ?? [], {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
    });
    if (joinable && isConfirmedStatus(vm.status) && vm.raw.appointment) {
      return {
        kind: "join",
        label: "Join",
        onClick: () => void joinNow(vm, joinable),
        busy: joiningId === vm.id,
      };
    }
    if (
      vm.needsActionReason === "PAY_NOW" &&
      vm.pendingPaymentUrl &&
      /^https?:\/\//.test(vm.pendingPaymentUrl)
    ) {
      return { kind: "pay", label: "Pay now", href: vm.pendingPaymentUrl };
    }
    return { kind: "view", label: "View" };
  };

  const overflowItems = (vm: AppointmentVM): OverflowItem[] => {
    const items: OverflowItem[] = [];
    const inactive = isInactiveStatus(vm.status);
    const slots = vm.raw.rawSlots ?? [];
    const firstRaw = slots[0];
    const tentative = firstRaw?.isTentative ?? false;
    // A released slot awaiting a new time IS the open reschedule: at most one
    // may be live per appointment (the nullable-unique openForAppointmentId),
    // so offering the action again only earns a 409.
    const rescheduleInFlight = slots.some(
      (slot) => slot.completionStatus === "RESCHEDULED",
    );

    if (
      vm.appointmentId &&
      !inactive &&
      !tentative &&
      isApprovedStatus(vm.status) &&
      // An APPROVED booking with nothing allocated yet ("Not scheduled · 0/0")
      // has no time to move. The proposal window is derived from the earliest
      // released session, so this would fail with PROPOSAL_WINDOW_CLOSED.
      slots.length > 0 &&
      !rescheduleInFlight
    ) {
      items.push({
        key: "reschedule",
        label: "Reschedule",
        onClick: () =>
          // One surface for every reschedule. The modal skips its
          // session-picker step when there is only one session, so a
          // consultation opens straight on "pick a new time" — a second dialog
          // for the same action is how the four planner dialogs started.
          openDialog(vm, "reschedule-multi"),
      });
    }
    if (vm.appointmentId && !inactive) {
      items.push({
        key: "cancel",
        label: isPendingPaymentStatus(vm.status)
          ? "Cancel request"
          : "Cancel booking",
        destructive: true,
        onClick: () => openDialog(vm, "cancel"),
      });
    }
    if (
      vm.appointmentId &&
      isConfirmedStatus(vm.status) &&
      (vm.kind === "CONSULTATION" ||
        vm.kind === "TRIAL" ||
        vm.kind === "SUBSCRIPTION")
    ) {
      items.push({
        key: "documents",
        label: "Documents",
        onClick: () => openDialog(vm, "documents"),
      });
    }
    if (vm.appointmentId) {
      items.push({
        key: "report",
        label: "Report issue",
        onClick: () => openDialog(vm, "report"),
      });
    }
    if (
      isDev &&
      vm.raw.appointment &&
      (vm.raw.rawSlots?.length ?? 0) > 0 &&
      !getJoinableSlot(vm.raw.rawSlots ?? [], {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      })
    ) {
      items.push({
        key: "dev-join",
        label: "Force join (dev)",
        onClick: () => void joinNow(vm, vm.raw.rawSlots![0]),
      });
    }
    return items;
  };

  const renderDialogs = () => {
    if (!activeVm) return null;
    const isPendingPayment = isPendingPaymentStatus(activeVm.status);
    const scheduledAt = activeVm.raw.rawSlots?.[0]
      ? new Date(activeVm.raw.rawSlots[0].startsAt as Date | string).toISOString()
      : undefined;

    return (
      <>
        <CancelConfirmationDialog
          isOpen={dialog === "cancel"}
          onConfirm={async () => {
            await actions.handleCancelConfirm();
            closeDialog();
          }}
          onCancel={closeDialog}
          title={activeVm.title}
          consultant={activeVm.counterpart.name}
          appointmentType={typeLabel}
          isLoading={actions.isLoading}
          isPendingPayment={isPendingPayment}
        />

        <RescheduleSessionsModal
          open={dialog === "reschedule-multi"}
          onOpenChange={(open) => !open && closeDialog()}
          typeLabel={typeLabel}
          rawSlots={activeVm.raw.rawSlots ?? []}
          isLoading={actions.isLoading}
          consultantProfileId={activeVm.consultantProfileId}
          consulteeUserId={session?.user?.id}
          sessionDurationInHours={
            activeVm.raw.appointment?.subscription?.subscriptionPlan
              ?.sessionDurationInHours ?? undefined
          }
          onConfirm={({ slotIds, proposedSlots }) => {
            closeDialog();
            void actions.handleReschedule(slotIds, proposedSlots);
          }}
        />

        {activeVm.appointmentId && dialog === "report" && (
          <ReportIssueDialog
            open
            onOpenChange={(open) => !open && closeDialog()}
            appointmentId={activeVm.appointmentId}
            appointmentType={KIND_TO_REPORT_TYPE[activeVm.kind]}
            appointmentStatus={
              activeVm.status === "COMPLETED" ? "COMPLETED" : "UPCOMING"
            }
            consultantName={activeVm.counterpart.name}
            scheduledAt={scheduledAt}
            onSuccess={closeDialog}
          />
        )}

        {activeVm.appointmentId && dialog === "documents" && (
          <DocumentUpload
            appointmentId={activeVm.appointmentId}
            appointmentTitle={activeVm.title}
            appointmentType={typeLabel}
            defaultOpen
            onOpenChange={(open) => !open && closeDialog()}
          />
        )}
      </>
    );
  };

  return {
    role: "consultee",
    detailHref: (vm) =>
      vm.appointmentId && consulteeId
        ? `/dashboard/consultee/${consulteeId}/appointments/${vm.appointmentId}`
        : null,
    primaryAction,
    overflowItems,
    renderDialogs,
  };
}
