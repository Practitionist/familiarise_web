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
  allowsUnschedule,
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableOccurrence,
  occurrencesAllowReschedule,
  upcomingOccurrences,
} from "@/lib/appointments/occurrences";
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
import { chatAffordancesForVm } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { UnscheduleConfirmationDialog } from "@/components/appointments/UnscheduleConfirmationDialog";
import { ConsultantResponseUpload } from "../documents/ConsultantResponseUpload";

type DialogKind = "cancel" | "unschedule" | "documents";

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
  // Shared with the timings page's own gate, so the menu cannot offer a route
  // that then 404s on a different reading of the same slots (#1082).
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
    lifecycleOk &&
    !inactive &&
    isApprovedStatus(vm.status) &&
    !timingsOk &&
    occurrencesAllowReschedule(rawOccurrences),
  );
}

function canOfferUnschedule(
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
    allowsUnschedule(vm.kind, rawOccurrences),
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
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [activeVm, setActiveVm] = useState<AppointmentVM | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  // #1270 — one flag, not three. This surface keyed off NODE_ENV while its
  // consultee sibling keyed off NEXT_PUBLIC_ENABLE_DEV_TOOLS, so the same
  // backdoor was open in different places on the same build. The explicit
  // opt-in wins: NODE_ENV is true for every local run whether or not the
  // developer asked for the escape hatch.
  const isDev = process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";

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

  const joinableSlotOf = (vm: AppointmentVM) =>
    getJoinableOccurrence(vm.raw.appointment?.occurrences ?? [], {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
    });

  const joinVm = async (vm: AppointmentVM, force = false) => {
    setJoiningId(vm.id);
    let navigating = false;
    if (vm.kind === "TRIAL") {
      const trial = vm.raw.source as ConsultantTrialLike;
      const slot = trial.appointment?.occurrences?.[0];
      if (trial.appointment && slot) {
        navigating = await joinMeeting(
          {
            id: trial.appointment.id,
            appointmentType: "TRIAL",
            occurrences: [
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
        ? vm.raw.appointment.occurrences?.[0]
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
   *
   * Pure href builder so the primary "Set schedule" action can render as a
   * prefetching Link (PrimaryAction.href); the overflow menu items below
   * still go through `openTimings` because OverflowItem only carries onClick.
   */
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
    const trial = vm.raw.source as ConsultantTrialLike;
    const slots = trial.appointment?.occurrences ?? [];
    return (
      getJoinableOccurrence(
        slots.map((s) => ({ ...s, isTentative: false })),
        { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS },
      ) !== null
    );
  };

  /**
   * The whole join gate: a confirmed booking whose session is inside its
   * window.
   *
   * #1270 — the status half was missing. The non-trial branch gated on
   * `bucket !== "cancelled"` alone, which is only the terminal-NEGATIVE
   * statuses, so a consultant could open the room for a booking still at
   * APPROVED_PENDING_PAYMENT (nobody has paid) or already COMPLETED (the
   * session is over and its recording is sealed). The trial branch checked no
   * status at all. `isConfirmedStatus` is what the consultee adapter has
   * always required, and it subsumes the cancelled-bucket check.
   */
  const canJoinNow = (vm: AppointmentVM): boolean => {
    if (!isConfirmedStatus(vm.status)) return false;
    return vm.kind === "TRIAL"
      ? trialJoinable(vm)
      : joinableSlotOf(vm) !== null;
  };

  /** Slot rows exist to key a room to, joinable or not — the dev arm's target. */
  const hasSlotRows = (vm: AppointmentVM): boolean => {
    if (vm.kind === "TRIAL") {
      const trial = vm.raw.source as ConsultantTrialLike | undefined;
      return (trial?.appointment?.occurrences?.length ?? 0) > 0;
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
    const rawOccurrences = actionableRawSlots(vm);
    const lifecycleOk = canManageBookingLifecycle(vm);
    const timingsOk = allowsManageTimings(vm.kind, rawOccurrences);

    if (canOfferTimings(vm, timingsOk)) {
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
      canOfferReschedule(vm, lifecycleOk, inactive, timingsOk, rawOccurrences)
    ) {
      items.push({
        key: "reschedule",
        label: "Reschedule",
        onClick: () =>
          router.push(
            `/dashboard/consultant/${consultantId}/appointments/${vm.appointmentId}/reschedule`,
          ),
      });
    }
    if (canOfferUnschedule(vm, lifecycleOk, inactive, rawOccurrences)) {
      items.push({
        key: "unschedule",
        label: "Unschedule",
        onClick: () => openDialog(vm, "unschedule"),
      });
    }
    if (vm.appointmentId && vm.kind !== "TRIAL" && lifecycleOk && !inactive) {
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
        label: "Upload document",
        onClick: () => openDialog(vm, "documents"),
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
            onConfirm={async () => {
              await actions.handleCancelConfirm();
              closeDialog();
            }}
            onCancel={closeDialog}
            title={activeVm.title}
            consultant={activeVm.counterpart.name}
            appointmentType={typeLabel}
            isLoading={actions.isLoading}
            appointmentId={activeVm.appointmentId}
          />

          <UnscheduleConfirmationDialog
            isOpen={dialog === "unschedule"}
            onConfirm={async () => {
              await actions.handleUnschedule();
              closeDialog();
            }}
            onCancel={closeDialog}
            title={activeVm.title}
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
