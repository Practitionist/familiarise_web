import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DashboardViewportFill } from "@/components/dashboard/DashboardViewportFill";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import prisma from "@/lib/prisma";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import {
  INCIDENT_REBOOK_HORIZON_DAYS,
  readOpenIncidentRemedies,
} from "@/lib/booking/incident-rebook";
import { buildRescheduleSubject } from "@/lib/scheduling/time-picker-subject";
import { getPersonalViewerZone } from "@/lib/time/viewer-zone-server";

import { RebookClient } from "./RebookClient";

export const metadata: Metadata = { title: "Rebook free — Familiarise" };

type PageProps = {
  params: Promise<{ consulteeId: string; appointmentId: string }>;
};

const HOUR_MS = 3_600_000;

/** The free rebook of an outage-voided 1:1: the expert's grid, at the voided session's length. */
export default async function RebookAppointmentPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;
  await requirePersonalProfileAccess("consultee", consulteeId);
  const profile = await prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  });
  if (!profile) notFound();
  const backHref = `/dashboard/consultee/${consulteeId}/appointments/${appointmentId}`;

  // The open remedy is keyed to this learner, so it also proves the booking is theirs.
  const [remedy] = await readOpenIncidentRemedies(
    profile.userId,
    appointmentId,
  );
  if (!remedy) {
    return (
      <DashboardViewportFill className="gap-4">
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <CalendarX className="h-7 w-7 text-muted-foreground/70" />
          </div>
          <h1 className="text-base font-medium text-foreground">
            There is nothing to rebook here
          </h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            This session was already rebooked or refunded, or its refund is now
            on its way.
          </p>
          <Button variant="outline" size="sm" className="mt-4" asChild>
            <Link href={backHref}>Back to the booking</Link>
          </Button>
        </div>
      </DashboardViewportFill>
    );
  }

  const detail = await readAppointmentDetail(appointmentId);
  const resolved = detail ? buildRescheduleSubject(detail) : null;
  if (!resolved) notFound();

  const hours =
    (Date.parse(remedy.sessionEndsAt) - Date.parse(remedy.sessionStartsAt)) /
    HOUR_MS;
  const now = new Date();
  const viewerZone = await getPersonalViewerZone("consultee", consulteeId);

  return (
    <DashboardViewportFill className="gap-4">
      <div className="shrink-0">
        <PanelHeader
          description={`Choose a new time with ${remedy.expertName ?? "your expert"} in the next ${INCIDENT_REBOOK_HORIZON_DAYS} days. It is free: the payment you already made covers it.`}
        />
      </div>
      <RebookClient
        remedyId={remedy.id}
        title={remedy.title}
        subject={{
          ...resolved.subject,
          durationInHours: hours,
          sessionDurationInHours: hours,
          allowedStart: now,
          allowedEnd: new Date(
            now.getTime() + INCIDENT_REBOOK_HORIZON_DAYS * 24 * HOUR_MS,
          ),
          slots: [],
          hasReleasedSlots: false,
        }}
        backHref={backHref}
        viewerZone={viewerZone.zone}
      />
    </DashboardViewportFill>
  );
}
