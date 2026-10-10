import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardViewportFill } from "@/components/dashboard/DashboardViewportFill";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { resolvePrimaryPlanOwnerIds } from "@/lib/booking/plan-owners";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { buildRescheduleSubject } from "@/lib/scheduling/time-picker-subject";

import { RescheduleClient } from "./RescheduleClient";

/**
 * The consultant's reschedule surface.
 *
 * Required, not extra. The consultant's appointments rows used to open the
 * consultee's dialog; the consultee ROUTE checks
 * `requirePersonalProfileAccess("consultee", …)`, which a consultant fails —
 * so this is what keeps consultants able to reschedule once that dialog is
 * gone. Same picker, same policy shape, different auth and copy.
 */
type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadDetail = cache(readAppointmentDetail);

export async function generateMetadata({
  params,
}: Readonly<PageProps>): Promise<Metadata> {
  const { consultantId, appointmentId } = await params;
  const detail = await loadDetail(appointmentId).catch(() => null);
  const owned =
    Boolean(consultantId) &&
    detail !== null &&
    resolvePrimaryPlanOwnerIds(detail.appointment).includes(consultantId);
  const resolved = owned && detail ? buildRescheduleSubject(detail) : null;
  if (!resolved) return { title: "Reschedule — Familiarise" };

  const who = resolved.consulteeName ? ` · ${resolved.consulteeName}` : "";
  return { title: `Reschedule: ${resolved.title}${who} — Familiarise` };
}

export default async function ConsultantReschedulePage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, appointmentId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);

  const detail = await loadDetail(appointmentId);
  if (!detail) notFound();

  const { appointment } = detail;
  if (
    !consultantId ||
    !resolvePrimaryPlanOwnerIds(appointment).includes(consultantId)
  ) {
    notFound();
  }

  const resolved = buildRescheduleSubject(detail);
  if (!resolved) notFound();

  const backHref = `/dashboard/consultant/${consultantId}/appointments`;

  return (
    <DashboardViewportFill className="gap-4">
      {/* The BOOKING now lives in the breadcrumb (RescheduleClient sets it
          via useSetBreadcrumbLabel) — see the consultee's twin (#1064). */}
      <div className="shrink-0">
        <PanelHeader
          description={
            resolved.consulteeName
              ? `Propose a new time for ${resolved.consulteeName}`
              : "Propose a new time"
          }
        />
      </div>

      <RescheduleClient
        consultantId={consultantId}
        appointmentId={appointmentId}
        title={resolved.title}
        typeLabel={resolved.typeLabel}
        subject={resolved.subject}
        backHref={backHref}
      />
    </DashboardViewportFill>
  );
}
