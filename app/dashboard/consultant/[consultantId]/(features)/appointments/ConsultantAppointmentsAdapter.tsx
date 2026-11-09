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
  getJoinableOccurrence,
  occurrencesAllowReschedule,
  upcomingOccurrences,
} from "@/lib/appointments/occurrences";
import {
  allowsRetime,
  rescheduleReleasable,
} from "@/lib/booking/reschedule-proposals";
import { newTimeDoor } from "@/lib/appointments/new-time-door";
import {
  isApprovedStatus,
  isConfirmedStatus,
  isInactiveStatus,
} from "@/lib/appointments/status";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type { ConsultantTrialLike } from "@/lib/appointments/map-consultant";
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import { useNowTick } from "@/hooks/use-now-tick";
import { useSession } from "@/lib/auth-client";
import { operatorOpsHref } from "@/lib/backoffice/booking-href";
import { getParticipantManagementUrl } from "./utils/participantHelpers";
import { useConsultantEventActions } from "./components/useConsultantEventActions";
import { CancelConfirmationDialog } from "@/components/appointments/consultee/CancelConfirmationDialog";
import {
  chatAffordancesForVm,
  consultantUserIdOf,
  consulteeUserIdOf,
} from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { OPS_HINT_LABEL } from "@/components/appointments/OperatorOpsHint";
import { RetimeDialog } from "@/components/appointments/RetimeDialog";

type DialogKind = "cancel" | "retime";

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
  if (vm.raw.rawOccurrences?.length) return vm.raw.rawOccurrences;
  const sources =
    vm.raw.groupAppointments && vm.raw.groupAppointments.length > 0
      ? vm.raw.groupAppointments
      : vm.raw.appointment
        ? [vm.raw.appointment]
        : [];
  return upcomingOccurrences(sources.flatMap((a) => a.occurrences ?? []));
}

function canOfferTimings(vm: AppointmentVM, timingsOk: boolean): boolean {
  return Boolean(
    vm.raw.appointment &&
    vm.bucket !== "cancelled" &&
    vm.bucket !== "past" &&
    timingsOk,
  );
}

function canOfferReschedule(
  vm: AppointmentVM,
  lifecycleOk: boolean,
  inactive: boolean,
  timingsOk: boolean,
  rawOccurrences: ReturnType<typeof actionableRawSlots>,
): boolean {
  return Boolean(
    vm.appointmentId &&
    vm.kind !== "TRIAL" &&
    vm.kind !== "WEBINAR" &&
    vm.kind !== "CLASS" &&
    lifecycleOk &&
    !inactive &&
    isApprovedStatus(vm.status) &&
    !timingsOk &&
    occurrencesAllowReschedule(rawOccurrences) &&
    rescheduleReleasable(rawOccurrences),
  );
}

function canOfferRetime(
  vm: AppointmentVM,
  lifecycleOk: boolean,
  inactive: boolean,
  rawOccurrences: ReturnType<typeof actionableRawSlots>,
): boolean {
  return Boolean(
    vm.appointmentId &&
    lifecycleOk &&
    !inactive &&
    isConfirmedStatus(vm.status) &&
    allowsRetime(vm.kind, rawOccurrences),
  );
}

function canOfferDocuments(vm: AppointmentVM): boolean {
  return Boolean(
    vm.appointmentId &&
    isConfirmedStatus(vm.status) &&
    (vm.kind === "CONSULTATION" ||
      vm.kind === "SUBSCRIPTION" ||
      vm.kind === "TRIAL"),
  );
}

export function useConsultantAppointmentsAdapter(
  consultantId: string,
): AppointmentActionAdapter {
  const router = useRouter();
  const joinMeeting = useLazyJoinMeeting();
  const now = useNowTick();
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [activeVm, setActiveVm] = useState<AppointmentVM | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  const isDev = process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";

  const viewer = useSession().data?.user;
  const isPartyTo = (vm: AppointmentVM): boolean =>
    Boolean(
      viewer &&
      ((viewer.consultantProfileId &&
        viewer.consultantProfileId === consultantId) ||
        [consultantUserIdOf(vm), consulteeUserIdOf(vm)].includes(viewer.id)),
    );

  const typeLabel = activeVm
    ? TYPE_LABEL[activeVm.kind]
    : ("Consultation" as const);

  const rawOccurrences = useMemo(
    () => (activeVm ? actionableRawSlots(activeVm) : []),
    [activeVm],
  );

  const actions = useConsultantEventActions({
    consultantId,
    appointmentId: activeVm?.appointmentId ?? undefined,
    rawOccurrences,
    title: activeVm?.title ?? "",
    type: typeLabel as
      "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial",
  });

  const openDialog = (vm: AppointmentVM, kind: DialogKind) => {
    setActiveVm(vm);
    setDialog(kind);
  };
  const closeDialog = () => setDialog(null);

  const trialSlotsOf = (vm: AppointmentVM) => {
    const trial = vm.raw.source as ConsultantTrialLike | undefined;
    return (
      trial?.appointment?.occurrences ?? vm.raw.appointment?.occurrences ?? []
    );
  };

  const joinableSlotOf = (vm: AppointmentVM) =>
    getJoinableOccurrence(
      vm.kind === "TRIAL"
        ? trialSlotsOf(vm)
        : (vm.raw.appointment?.occurrences ?? []),
      {
        joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
        now,
      },
    );

  const resolveTrialJoinSlot = (
    vm: AppointmentVM,
    force: boolean,
    targetOccurrence?: import("@/lib/appointments/view-model").OccurrenceVM,
  ) => {
    const slots = trialSlotsOf(vm);
    if (targetOccurrence) {
      return (
        slots.find((s) => s.id === targetOccurrence.occurrenceId) ?? slots[0]
      );
    }
    if (force) {
      return slots[0];
    }
    return joinableSlotOf(vm) ?? slots[0];
  };

  const resolveAppointmentJoinTarget = (
    vm: AppointmentVM,
    primaryAppointment: NonNullable<AppointmentVM["raw"]["appointment"]>,
    force: boolean,
    targetOccurrence?: import("@/lib/appointments/view-model").OccurrenceVM,
  ) => {
    const candidates = vm.raw.groupAppointments?.length
      ? vm.raw.groupAppointments
      : [primaryAppointment];
    if (targetOccurrence) {
      for (const candidate of candidates) {
        const matched = candidate.occurrences?.find(
          (s) => s.id === targetOccurrence.occurrenceId,
        );
        if (matched) {
          return { appointment: candidate, slot: matched };
        }
      }
      return {
        appointment: primaryAppointment,
        slot: joinableSlotOf(vm) ?? undefined,
      };
    }
    if (force) {
      return {
        appointment: primaryAppointment,
        slot: primaryAppointment.occurrences?.[0],
      };
    }
    return {
      appointment: primaryAppointment,
      slot: joinableSlotOf(vm) ?? undefined,
    };
  };

  const joinVm = async (
    vm: AppointmentVM,
    force = false,
    targetOccurrence?: import("@/lib/appointments/view-model").OccurrenceVM,
  ) => {
    setJoiningId(vm.id);
    let navigating = false;
    if (vm.kind === "TRIAL") {
      const trial = vm.raw.source as ConsultantTrialLike | undefined;
      const apptId = trial?.appointment?.id ?? vm.raw.appointment?.id;
      const slot = resolveTrialJoinSlot(vm, force, targetOccurrence);
      if (apptId && slot) {
        const trialSlot = {
          id: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          isTentative: slot.isTentative,
          appointmentId: apptId,
        };
        navigating = await joinMeeting(
          {
            id: apptId,
            appointmentType: "TRIAL",
            occurrences: [trialSlot],
          },
          trialSlot,
        );
      }
    } else if (vm.raw.appointment) {
      const target = resolveAppointmentJoinTarget(
        vm,
        vm.raw.appointment,
        force,
        targetOccurrence,
      );
      navigating = await joinMeeting(target.appointment, target.slot);
    }
    if (!navigating) setJoiningId(null);
  };

  const timingsHref = (vm: AppointmentVM): string | null => {
    const targetId =
      vm.id.startsWith("unscheduled-class-") ||
      vm.id.startsWith("unscheduled-webinar-")
        ? vm.id
        : vm.appointmentId;
    if (!targetId) return null;
    return `/dashboard/consultant/${consultantId}/appointments/${targetId}/timings`;
  };

  const openTimings = (vm: AppointmentVM) => {
    const href = timingsHref(vm);
    if (!href) return;
    router.push(href);
  };

  const trialJoinable = (vm: AppointmentVM) => {
    if (vm.kind !== "TRIAL") return false;
    return (
      getJoinableOccurrence(trialSlotsOf(vm), {
        joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
        now,
      }) !== null
    );
  };

  const canJoinNow = (vm: AppointmentVM): boolean => {
    if (!isConfirmedStatus(vm.status)) return false;
    return vm.kind === "TRIAL"
      ? trialJoinable(vm)
      : joinableSlotOf(vm) !== null;
  };

  const hasSlotRows = (vm: AppointmentVM): boolean => {
    if (vm.kind === "TRIAL") {
      return trialSlotsOf(vm).length > 0;
    }
    return (vm.raw.appointment?.occurrences?.length ?? 0) > 0;
  };

  const primaryAction = (vm: AppointmentVM): PrimaryAction => {
    if (vm.needsActionReason === "UNSCHEDULED") {
      const href = timingsHref(vm);
      if (href) {
        return {
          kind: "schedule",
          label: "Set schedule",
          href,
        };
      }
    }
    if (canJoinNow(vm)) {
      return {
        kind: "join",
        label: "Join",
        onClick: (targetOccurrence) => void joinVm(vm, false, targetOccurrence),
        busy: joiningId === vm.id,
      };
    }
    return { kind: "view", label: "View" };
  };

  const overflowItems = (vm: AppointmentVM): OverflowItem[] => {
    const items: OverflowItem[] = [];
    const appointment = vm.raw.appointment;
    const inactive = isInactiveStatus(vm.status);
    const rawOccurrences = actionableRawSlots(vm);
    const lifecycleOk = canManageBookingLifecycle(vm);
    const timingsOk = allowsManageTimings(
      vm.kind,
      rawOccurrences,
      vm.raw.liveSeats ?? 0,
    );

    if (canOfferTimings(vm, timingsOk)) {
      items.push({
        key: "timings",
        label: "Timings",
        onClick: () => openTimings(vm),
      });
    }
    const participantsUrl = appointment
      ? getParticipantManagementUrl(appointment, consultantId)
      : null;
    if (participantsUrl) {
      items.push({
        key: "participants",
        label: "Participants",
        onClick: () => router.push(participantsUrl),
      });
    }
    const mayReschedule = canOfferReschedule(
      vm,
      lifecycleOk,
      inactive,
      timingsOk,
      rawOccurrences,
    );
    const mayCancel = Boolean(
      vm.appointmentId && vm.kind !== "TRIAL" && lifecycleOk && !inactive,
    );
    const opsHref = vm.appointmentId
      ? operatorOpsHref(viewer, isPartyTo(vm), vm.appointmentId)
      : null;
    if (mayReschedule && !opsHref) {
      items.push({
        key: "reschedule",
        label: "Reschedule",
        onClick: () =>
          router.push(
            `/dashboard/consultant/${consultantId}/appointments/${vm.appointmentId}/reschedule`,
          ),
      });
    }
    if (
      vm.needsActionReason === "NEEDS_RESCHEDULING" &&
      vm.appointmentId &&
      lifecycleOk &&
      !inactive &&
      !opsHref
    ) {
      const next = newTimeDoor({
        consultantId,
        status: vm.status,
        consultationId: vm.raw.appointment?.consultationId,
        subscriptionId: vm.raw.appointment?.subscriptionId,
      });
      items.push({
        key: "new-time",
        label: next.label,
        href: next.href,
        onClick: () => router.push(next.href),
      });
    }
    if (canOfferRetime(vm, lifecycleOk, inactive, rawOccurrences)) {
      items.push({
        key: "retime",
        label: "Move to a new date",
        onClick: () => openDialog(vm, "retime"),
      });
    }
    if (opsHref && (mayReschedule || mayCancel)) {
      items.push({
        key: "ops-hint",
        label: OPS_HINT_LABEL,
        href: opsHref,
        onClick: () => router.push(opsHref),
      });
    } else if (mayCancel) {
      items.push({
        key: "cancel",
        label: "Cancel booking",
        destructive: true,
        onClick: () => openDialog(vm, "cancel"),
      });
    }
    if (canOfferDocuments(vm)) {
      items.push({
        key: "documents",
        label: "Session documents",
        onClick: () =>
          router.push(
            `/dashboard/consultant/${consultantId}/appointments/${vm.appointmentId}/documents`,
          ),
      });
    }

    items.push(
      ...chatAffordancesForVm({
        vm,
        messagesBasePath: `/dashboard/consultant/${consultantId}/messages`,
        role: "consultant",
        push: (href) => router.push(href),
      }),
    );

    if (isDev && hasSlotRows(vm) && !canJoinNow(vm)) {
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
            onConfirm={async (quote) => {
              if (await actions.handleCancelConfirm(quote)) closeDialog();
            }}
            onCancel={closeDialog}
            title={activeVm.title}
            consultant={activeVm.counterpart.name}
            appointmentType={typeLabel}
            isLoading={actions.isLoading}
            appointmentId={activeVm.appointmentId}
            viewerRole="consultant"
          />

          <RetimeDialog
            isOpen={dialog === "retime"}
            onConfirm={async (startsAt) => {
              const moved = await actions.handleRetime(startsAt);
              if (moved) closeDialog();
              return moved;
            }}
            onCancel={closeDialog}
            title={activeVm.title}
            isLoading={actions.isLoading}
          />
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
