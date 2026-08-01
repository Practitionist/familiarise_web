"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AppointmentActionAdapter,
  OverflowItem,
  PrimaryAction,
} from "@/lib/appointments/adapter";
import {
  allowsManageTimings,
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableSlot,
  slotsAllowReschedule,
  upcomingSlots,
} from "@/lib/appointments/slots";
import {
  isApprovedStatus,
  isConfirmedStatus,
  isInactiveStatus,
} from "@/lib/appointments/status";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type { ConsultantTrialLike } from "@/lib/appointments/map-consultant";
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import {
  getParticipantManagementUrl,
  supportsParticipantManagement,
} from "./utils/participantHelpers";
import { useConsultantEventActions } from "./components/useConsultantEventActions";
import { CancelConfirmationDialog } from "@/components/appointments/consultee/CancelConfirmationDialog";
import { ConsultantResponseUpload } from "../documents/ConsultantResponseUpload";

type DialogKind = "cancel" | "documents";

const TYPE_LABEL: Record<AppointmentVM["kind"], string> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
};

/** Webinar/class lifecycle actions are plan-owner only (API rejects collaborators). */
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
  // Shared with the timings page's own gate, so the menu cannot offer a route
  // that then 404s on a different reading of the same slots (#1082).
  return upcomingSlots(sources.flatMap((a) => a.slotsOfAppointment ?? []));
}

export function useConsultantAppointmentsAdapter(
  consultantId: string,
): AppointmentActionAdapter {
  const router = useRouter();
  const joinMeeting = useLazyJoinMeeting();
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

  /**
   * `vm.id` already carries the `unscheduled-class-`/`unscheduled-webinar-`
   * prefix for an offering with no `Appointment` row yet; a scheduled one
   * routes on the real appointment id. The timings page resolves either
   * shape itself (lib/data/manage-timings-target.ts).
   */
  const openTimings = (vm: AppointmentVM) => {
    const targetId =
      vm.id.startsWith("unscheduled-class-") ||
      vm.id.startsWith("unscheduled-webinar-")
        ? vm.id
        : vm.appointmentId;
    if (!targetId) return;
    router.push(
      `/dashboard/consultant/${consultantId}/appointments/${targetId}/timings`,
    );
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
    const rawSlots = actionableRawSlots(vm);
    const lifecycleOk = canManageBookingLifecycle(vm);
    const isTrial = vm.kind === "TRIAL";

    // Manage Timings moves sessions with no notice and no acceptance, so it is
    // only offered where nobody else has committed to the time. A 1:1 whose
    // consultee already holds a confirmed slot gets Reschedule below instead —
    // the two are alternatives, never both (#1082).
    const timingsOk = allowsManageTimings(vm.kind, rawSlots);

    if (
      appointment &&
      vm.bucket !== "cancelled" &&
      vm.bucket !== "past" &&
      timingsOk
    ) {
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
      isApprovedStatus(vm.status) &&
      // Reschedule is the negotiated path, so it belongs exactly where Manage
      // Timings does not: a booking a counterparty holds a confirmed time on.
      !timingsOk &&
      slotsAllowReschedule(rawSlots)
    ) {
      items.push({
        key: "reschedule",
        label: "Reschedule",
        // The consultant's OWN reschedule route. This surface used to mount
        // the consultee's dialog, which has no equivalent page a consultant
        // may open: that route's consultee ownership check would 403 them.
        onClick: () =>
          router.push(
            `/dashboard/consultant/${consultantId}/appointments/${vm.appointmentId}/reschedule`,
          ),
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
