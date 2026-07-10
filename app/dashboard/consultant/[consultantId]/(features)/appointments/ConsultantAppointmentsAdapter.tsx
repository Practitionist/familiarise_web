"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AppointmentActionAdapter,
  OverflowItem,
  PrimaryAction,
} from "@/lib/appointments/adapter";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableSlot,
} from "@/lib/appointments/slots";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type {
  ConsultantTrialLike,
  UnscheduledClassLike,
  UnscheduledWebinarLike,
} from "@/lib/appointments/map-consultant";
import type { TAppointment } from "@/types/appointment";
import type { UnscheduledClass, UnscheduledWebinar } from "../../types";
import { useLazyJoinMeeting } from "../shared/hooks/useLazyJoinMeeting";
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

interface TimingsTarget {
  appointment: TAppointment | UnscheduledAppointment;
  groupProgress: { completedSessions: number; totalSessions: number } | null;
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

  // Dev affordance parity with the old group card: joining outside the
  // window stays possible in non-prod builds — it's how flows get tested.
  const isDev = process.env.NODE_ENV !== "production";

  const joinableSlotOf = (vm: AppointmentVM) =>
    getJoinableSlot(vm.raw.appointment?.slotsOfAppointment ?? [], {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
    });

  const joinVm = async (vm: AppointmentVM, force = false) => {
    setJoiningId(vm.id);
    let navigating = false;
    if (vm.kind === "TRIAL") {
      // Trials come from the side query, not the appointments read — build
      // the minimal meeting shape (old handleJoinTrialMeeting).
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

  const renderDialogs = () => {
    if (!timingsTarget) return null;
    return (
      <EventTimingsCalendar
        isOpen
        onClose={() => setTimingsTarget(null)}
        appointment={timingsTarget.appointment}
        completedSessions={timingsTarget.groupProgress?.completedSessions}
        groupTotalSessions={timingsTarget.groupProgress?.totalSessions}
      />
    );
  };

  return {
    role: "consultant",
    detailHref: () => null, // detail pages land in a later chunk
    primaryAction,
    overflowItems,
    renderDialogs,
  };
}
