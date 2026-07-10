"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CalendarClock, Loader2 } from "lucide-react";
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
import { useEventActions } from "./components/useEventActions";
import { RescheduleSessionsModal } from "./components/RescheduleSessionsModal";
import { CancelConfirmationDialog } from "./CancelConfirmationDialog";
import { ReportIssueDialog } from "./ReportIssueDialog";
import { DocumentUpload } from "./DocumentUpload";

type DialogKind =
  | "cancel"
  | "reschedule-single"
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
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointment,
        slot as SlotOfAppointment,
      );
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
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
    const firstRaw = vm.raw.rawSlots?.[0];
    const tentative = firstRaw?.isTentative ?? false;

    if (
      vm.appointmentId &&
      !inactive &&
      !tentative &&
      isApprovedStatus(vm.status)
    ) {
      items.push({
        key: "reschedule",
        label: "Reschedule",
        onClick: () =>
          openDialog(vm, vm.group ? "reschedule-multi" : "reschedule-single"),
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
          onConfirm={(slotIds) => {
            closeDialog();
            void actions.handleReschedule(slotIds);
          }}
        />

        {/* Single-session reschedule confirmation (consultations/webinars/trials). */}
        <AlertDialog
          open={dialog === "reschedule-single"}
          onOpenChange={(open) => !open && closeDialog()}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <CalendarClock className="h-5 w-5 text-muted-foreground" />
                Reschedule {typeLabel}?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>
                    Are you sure you want to reschedule{" "}
                    <strong>&quot;{activeVm.title}&quot;</strong> with{" "}
                    <strong>{activeVm.counterpart.name}</strong>?
                  </p>
                  <p className="text-muted-foreground">
                    Your current time slot will be released and the{" "}
                    {typeLabel.toLowerCase()} status will revert to{" "}
                    <strong>Pending</strong> until a new time is allocated.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={actions.isLoading}>
                Keep Current Time
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  closeDialog();
                  void actions.handleReschedule();
                }}
                disabled={actions.isLoading}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {actions.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <CalendarClock className="h-4 w-4 mr-2" />
                )}
                Reschedule
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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
