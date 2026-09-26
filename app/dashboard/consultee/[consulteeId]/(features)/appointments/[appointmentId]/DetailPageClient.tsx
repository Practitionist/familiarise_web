"use client";

import Link from "next/link";
import { CalendarPlus, RotateCcw } from "lucide-react";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { AppointmentDocumentsList } from "@/components/appointments/detail/AppointmentDocumentsList";
import { Button } from "@/components/ui/button";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  isDeadOccurrence,
  isOccurrenceOver,
} from "@/lib/appointments/occurrences";
import {
  isCompletedLikeStatus,
  isConfirmedStatus,
} from "@/lib/appointments/status";
import { supportsDocuments } from "@/lib/appointments/kind-capabilities";
import { buildIcs } from "@/lib/appointments/ics";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { DocumentUpload } from "@/components/appointments/DocumentUpload";

/** Sessions worth putting in a calendar: booked (not held), live, not over. */
function calendarSessions(vm: AppointmentVM) {
  return vm.occurrences.filter(
    (o) => !o.isTentative && !isDeadOccurrence(o) && !isOccurrenceOver(o),
  );
}

/** #1527 — an .ics of the booking's upcoming sessions, built in the browser. */
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
  a.click();
  URL.revokeObjectURL(url);
}

function ConsulteeExtraActions({ vm }: Readonly<{ vm: AppointmentVM }>) {
  const canRebook =
    !!vm.consultantProfileId &&
    (vm.bucket === "past" || vm.bucket === "cancelled");
  const canAddToCalendar = calendarSessions(vm).length > 0;
  return (
    <>
      {canAddToCalendar && (
        <Button variant="outline" size="sm" onClick={() => downloadIcs(vm)}>
          <CalendarPlus className="mr-1.5 h-4 w-4" />
          Add to calendar
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
    </>
  );
}

export default function DetailPageClient({
  consulteeId,
  appointmentId,
}: Readonly<{ consulteeId: string; appointmentId: string }>) {
  const adapter = useConsulteeAppointmentsAdapter();

  return (
    <AppointmentDetailClient
      appointmentId={appointmentId}
      role="consultee"
      adapter={adapter}
      backHref={`/dashboard/consultee/${consulteeId}/appointments`}
      joinWindowMs={CONSULTEE_JOIN_WINDOW_MS}
      renderExtraActions={(vm) => <ConsulteeExtraActions vm={vm} />}
      renderDocuments={(vm) => {
        if (!supportsDocuments(vm.kind)) return null;
        // #1527 P0 — a finished booking keeps its files: read-only, the
        // learner's uploads beside the expert's responses.
        if (isCompletedLikeStatus(vm.status)) {
          return (
            <AppointmentDocumentsList
              appointmentId={appointmentId}
              viewer="consultee"
            />
          );
        }
        if (isConfirmedStatus(vm.status)) {
          return (
            <DocumentUpload
              appointmentId={appointmentId}
              appointmentTitle={vm.title}
              appointmentType={
                vm.kind.charAt(0) + vm.kind.slice(1).toLowerCase()
              }
            />
          );
        }
        return (
          <p className="text-xs text-muted-foreground">
            Documents can be shared once the booking is confirmed.
          </p>
        );
      }}
    />
  );
}
