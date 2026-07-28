"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2 } from "lucide-react";
import type {
  AppointmentActionAdapter,
  OverflowItem,
  PrimaryAction,
} from "@/lib/appointments/adapter";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableSlot,
} from "@/lib/appointments/slots";
import {
  isApprovedStatus,
  isConfirmedStatus,
  isInactiveStatus,
} from "@/lib/appointments/status";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type {
  ConsultantTrialLike,
  UnscheduledClassLike,
  UnscheduledWebinarLike,
} from "@/lib/appointments/map-consultant";
import type { TAppointment } from "@/types/appointment";
import type { UnscheduledClass, UnscheduledWebinar } from "../../types";
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import {
  buildUnscheduledClassAppointment,
  buildUnscheduledWebinarAppointment,
  type UnscheduledAppointment,
} from "./utils/unscheduledAppointments";
import {
  getParticipantManagementUrl,
  supportsParticipantManagement,
} from "./utils/participantHelpers";
import { EventTimingsCalendar } from "./components/EventTimingsCalendar";
import { useConsultantEventActions } from "./components/useConsultantEventActions";
import { CancelConfirmationDialog } from "@/components/appointments/consultee/CancelConfirmationDialog";
import { RescheduleSessionsModal } from "@/components/appointments/consultee/RescheduleSessionsModal";
import { ConsultantResponseUpload } from "../documents/ConsultantResponseUpload";
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

interface TimingsTarget {
  appointment: TAppointment | UnscheduledAppointment;
  groupProgress: { completedSessions: number; totalSessions: number } | null;
}

type DialogKind =
  | "cancel"
  | "reschedule-single"
  | "reschedule-multi"
  | "documents";

const TYPE_LABEL: Record<AppointmentVM["kind"], string> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
};

/** Webinar/class cancel+reschedule is plan-owner only (API rejects collaborators). */
function canManageBookingLifecycle(vm: AppointmentVM): boolean {
  if (vm.kind === "WEBINAR" || vm.kind === "CLASS") {
    return !vm.collaboratorRole || vm.collaboratorRole === "HOST";
  }
  return true;
}

function actionableRawSlots(vm: AppointmentVM) {
  if (vm.raw.rawSlots?.length) return vm.raw.rawSlots;
  const sources =
    vm.raw.groupAppointments && vm.raw.groupAppointments.length > 0
      ? vm.raw.groupAppointments
      : vm.raw.appointment
        ? [vm.raw.appointment]
        : [];
  const now = Date.now();
  return sources
    .flatMap((a) => a.slotsOfAppointment ?? [])
    .filter((slot) => new Date(slot.endsAt).getTime() >= now)
    .sort(
      (a, b) =>
        new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
}

export function useConsultantAppointmentsAdapter(
  consultantId: string,
): AppointmentActionAdapter {
  const router = useRouter();
  const joinMeeting = useLazyJoinMeeting();
  const [timingsTarget, setTimingsTarget] = useState<TimingsTarget | null>(
    null,
  );
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [activeVm, setActiveVm] = useState<AppointmentVM | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  const isDev = process.env.NODE_ENV !== "production";

  const typeLabel = activeVm
    ? TYPE_LABEL[activeVm.kind]
    : ("Consultation" as const);

  const rawSlots = useMemo(
    () => (activeVm ? actionableRawSlots(activeVm) : []),
    [activeVm],
  );

  const actions = useConsultantEventActions({
    consultantId,
    appointmentId: activeVm?.appointmentId ?? undefined,
    rawSlots,
    title: activeVm?.title ?? "",
    type: typeLabel as
      | "Consultation"
      | "Subscription"
      | "Webinar"
      | "Class"
      | "Trial",
  });

  const openDialog = (vm: AppointmentVM, kind: DialogKind) => {
    setActiveVm(vm);
    setDialog(kind);
  };
  const closeDialog = () => setDialog(null);

  const joinableSlotOf = (vm: AppointmentVM) =>
    getJoinableSlot(vm.raw.appointment?.slotsOfAppointment ?? [], {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
    });

  const joinVm = async (vm: AppointmentVM, force = false) => {
    setJoiningId(vm.id);
    let navigating = false;
    if (vm.kind === "TRIAL") {
      const trial = vm.raw.source as ConsultantTrialLike;
      const slot = trial.appointment?.slotsOfAppointment?.[0];
      if (trial.appointment && slot) {
        navigating = await joinMeeting(
          {
            id: trial.appointment.id,
            appointmentType: "TRIAL",
            slotsOfAppointment: [
              {
                id: slot.id,
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                appointmentId: trial.appointment.id,
              },
            ],
          },
          undefined,
        );
      }
    } else if (vm.raw.appointment) {
      const slot = force
        ? vm.raw.appointment.slotsOfAppointment?.[0]
        : (joinableSlotOf(vm) ?? undefined);
      navigating = await joinMeeting(vm.raw.appointment, slot);
    }
    if (!navigating) setJoiningId(null);
  };

  const openTimings = (vm: AppointmentVM) => {
    if (vm.id.startsWith("unscheduled-class-")) {
      setTimingsTarget({
        appointment: buildUnscheduledClassAppointment(
          vm.raw.source as UnscheduledClassLike as UnscheduledClass,
        ),
        groupProgress: null,
      });
      return;
    }
    if (vm.id.startsWith("unscheduled-webinar-")) {
      setTimingsTarget({
        appointment: buildUnscheduledWebinarAppointment(
          vm.raw.source as UnscheduledWebinarLike as UnscheduledWebinar,
        ),
        groupProgress: null,
      });
      return;
    }
    if (!vm.raw.appointment) return;
    setTimingsTarget({
      appointment: vm.raw.appointment,
      groupProgress: vm.group
        ? {
            completedSessions: vm.group.completed,
            totalSessions: vm.group.total,
          }
        : null,
    });
  };

  const trialJoinable = (vm: AppointmentVM) => {
    if (vm.kind !== "TRIAL") return false;
    const trial = vm.raw.source as ConsultantTrialLike;
    const slots = trial.appointment?.slotsOfAppointment ?? [];
    return (
      getJoinableSlot(
        slots.map((s) => ({ ...s, isTentative: false })),
        { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS },
      ) !== null
    );
  };

  const primaryAction = (vm: AppointmentVM): PrimaryAction => {
    if (vm.needsActionReason === "UNSCHEDULED") {
      return {
        kind: "schedule",
        label: "Set schedule",
        onClick: () => openTimings(vm),
      };
    }
    if (vm.kind === "TRIAL") {
      if (trialJoinable(vm) || (isDev && vm.appointmentId)) {
        return {
          kind: "join",
          label: isDev && !trialJoinable(vm) ? "Join (Dev)" : "Join",
          onClick: () => void joinVm(vm),
          busy: joiningId === vm.id,
        };
      }
      return { kind: "view", label: "View" };
    }
    const joinable = joinableSlotOf(vm);
    if (joinable && vm.bucket !== "cancelled") {
      return {
        kind: "join",
        label: "Join",
        onClick: () => void joinVm(vm),
        busy: joiningId === vm.id,
      };
    }
    return { kind: "view", label: "View" };
  };

  const overflowItems = (vm: AppointmentVM): OverflowItem[] => {
    const items: OverflowItem[] = [];
    const appointment = vm.raw.appointment;
    const inactive = isInactiveStatus(vm.status);
    const firstRaw = actionableRawSlots(vm)[0];
    const tentative = firstRaw?.isTentative ?? false;
    const lifecycleOk = canManageBookingLifecycle(vm);
    const isTrial = vm.kind === "TRIAL";

    if (appointment && vm.bucket !== "cancelled" && vm.bucket !== "past") {
      items.push({
        key: "timings",
        label: "Timings",
        onClick: () => openTimings(vm),
      });
    }
    if (appointment && supportsParticipantManagement(appointment)) {
      items.push({
        key: "participants",
        label: "Participants",
        onClick: () =>
          router.push(getParticipantManagementUrl(appointment, consultantId)),
      });
    }

    if (
      vm.appointmentId &&
      !isTrial &&
      lifecycleOk &&
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

    if (vm.appointmentId && !isTrial && lifecycleOk && !inactive) {
      items.push({
        key: "cancel",
        label: "Cancel booking",
        destructive: true,
        onClick: () => openDialog(vm, "cancel"),
      });
    }

    if (
      vm.appointmentId &&
      isConfirmedStatus(vm.status) &&
      (vm.kind === "CONSULTATION" ||
        vm.kind === "SUBSCRIPTION" ||
        vm.kind === "TRIAL")
    ) {
      items.push({
        key: "documents",
        label: "Upload document",
        onClick: () => openDialog(vm, "documents"),
      });
    }

    if (
      isDev &&
      vm.kind !== "TRIAL" &&
      appointment &&
      (appointment.slotsOfAppointment?.length ?? 0) > 0 &&
      !joinableSlotOf(vm)
    ) {
      items.push({
        key: "dev-join",
        label: "Join (Dev)",
        onClick: () => void joinVm(vm, true),
      });
    }
    return items;
  };

  const renderDialogs = () => (
    <>
      {timingsTarget && (
        <EventTimingsCalendar
          isOpen
          onClose={() => setTimingsTarget(null)}
          appointment={timingsTarget.appointment}
          completedSessions={timingsTarget.groupProgress?.completedSessions}
          groupTotalSessions={timingsTarget.groupProgress?.totalSessions}
        />
      )}

      {activeVm && (
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
          />

          <RescheduleSessionsModal
            open={dialog === "reschedule-multi"}
            onOpenChange={(open) => !open && closeDialog()}
            typeLabel={typeLabel}
            rawSlots={rawSlots}
            isLoading={actions.isLoading}
            onConfirm={(slotIds) => {
              closeDialog();
              void actions.handleReschedule(slotIds);
            }}
          />

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
                      The current time slot will be released and the{" "}
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CalendarClock className="mr-2 h-4 w-4" />
                  )}
                  Reschedule
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {activeVm.appointmentId && dialog === "documents" && (
            <ConsultantResponseUpload
              appointmentId={activeVm.appointmentId}
              isOpen
              onClose={closeDialog}
              onSuccess={closeDialog}
            />
          )}
        </>
      )}
    </>
  );

  return {
    role: "consultant",
    detailHref: (vm) =>
      vm.appointmentId
        ? `/dashboard/consultant/${consultantId}/appointments/${vm.appointmentId}`
        : null,
    primaryAction,
    overflowItems,
    renderDialogs,
  };
}
