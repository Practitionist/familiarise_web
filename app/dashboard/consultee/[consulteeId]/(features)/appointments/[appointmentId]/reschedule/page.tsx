import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardViewportFill } from "@/components/dashboard/DashboardViewportFill";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { OperatorOpsHint } from "@/components/appointments/OperatorOpsHint";
import prisma from "@/lib/prisma";
import {
  canAccessAppointment,
  readAppointmentDetail,
} from "@/lib/data/appointment-detail";
import { getSession } from "@/lib/auth-server";
import {
  requirePersonalProfileAccess,
  viewerOwnsPersonalProfile,
} from "@/lib/auth/personal-dashboard-access";
import { operatorOpsHref } from "@/lib/backoffice/booking-href";
import { safeReturnTo } from "@/lib/navigation/safe-path";
import { buildRescheduleSubject } from "@/lib/scheduling/time-picker-subject";
import { bookedSessionMinutes } from "@/lib/appointments/occurrences";

import { RescheduleClient } from "./RescheduleClient";
import { TrialRescheduleClient } from "./TrialRescheduleClient";

/**
 * The consultee's reschedule surface.
 *
 * A page rather than the dialog it replaces: every defect found reviewing that
 * dialog — labels overflowing their column, a legend that would not fit, a
 * selection lost on reload — traced back to width. The route also gives the
 * flow a URL, so "pick a new time" in a notification can link straight here.
 */
type PageProps = {
  params: Promise<{ consulteeId: string; appointmentId: string }>;
  // `string[]` is not hypothetical: a repeated ?returnTo= arrives as an array.
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadDetail = cache(readAppointmentDetail);
const loadConsulteeUserId = cache(async (consulteeId: string) =>
  prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  }),
);

/**
 * Binds the appointment to the URL's consultee. Mirrors the detail page.
 *
 * Shared with generateMetadata deliberately: metadata runs BEFORE the body's
 * guards and is not covered by them, so without this the page `<title>` named
 * the offering and the consultant for any appointment id a signed-in user
 * cared to try.
 */
function consulteeOwns(
  appointment: NonNullable<
    Awaited<ReturnType<typeof loadDetail>>
  >["appointment"],
  consulteeId: string,
  userId: string,
): boolean {
  return (
    appointment.consultation?.requestedBy?.id === consulteeId ||
    appointment.subscription?.requestedBy?.id === consulteeId ||
    appointment.trial?.consulteeProfile?.id === consulteeId ||
    appointment.participants.some((seat) => seat.userId === userId)
  );
}

/**
 * Names the booking, not the task. "Reschedule" on a backgrounded tab does not
 * say which of a consultee's sessions is being moved (#1064).
 */
export async function generateMetadata({
  params,
}: Readonly<PageProps>): Promise<Metadata> {
  const { consulteeId, appointmentId } = await params;
  const generic = { title: "Reschedule — Familiarise" };
  // Bound to the viewer before any read: a non-owner learns nothing.
  if (!(await viewerOwnsPersonalProfile("consultee", consulteeId))) {
    return generic;
  }
  const [detail, profile] = await Promise.all([
    loadDetail(appointmentId).catch(() => null),
    loadConsulteeUserId(consulteeId).catch(() => null),
  ]);
  if (!detail || !profile) return generic;
  if (!consulteeOwns(detail.appointment, consulteeId, profile.userId)) {
    return generic;
  }

  const resolved = buildRescheduleSubject(detail);
  if (!resolved) return generic;

  const who = resolved.consultantName ? ` with ${resolved.consultantName}` : "";
  return { title: `Reschedule: ${resolved.title}${who} — Familiarise` };
}

export default async function RescheduleAppointmentPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;
  const { returnTo } = await searchParams;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  const access = await requirePersonalProfileAccess("consultee", consulteeId);

  const [detail, profile] = await Promise.all([
    loadDetail(appointmentId),
    loadConsulteeUserId(consulteeId),
  ]);
  if (!detail || !profile) notFound();

  // Binds the appointment to the URL's consultee; binding that consultee to
  // the SESSION is the guard above.
  if (!consulteeOwns(detail.appointment, consulteeId, profile.userId)) {
    notFound();
  }

  // Org detail pages send ?returnTo= so finishing lands back in the org
  // context; safeReturnTo() decides it by parsing, so it is never off-site.
  const backHref = safeReturnTo(
    returnTo,
    `/dashboard/consultee/${consulteeId}/appointments`,
  );
  const opsHref = access.isInspecting
    ? operatorOpsHref(
        (await getSession())?.user,
        canAccessAppointment(access.userId, detail),
        appointmentId,
      )
    : null;

  // A trial is one session: the buyer's slot list picks its one new window.
  const trial = detail.appointment.trial;
  if (detail.appointment.appointmentType === "TRIAL" && trial) {
    const consultantName = trial.subscriptionPlan.consultantProfile?.user?.name;
    return (
      <DashboardViewportFill className="gap-4">
        <div className="shrink-0">
          <PanelHeader
            description={
              consultantName
                ? `Choose a new time for your trial with ${consultantName}`
                : "Choose a new time for your trial"
            }
          />
        </div>
        {opsHref ? (
          <OperatorOpsHint href={opsHref} />
        ) : (
          <TrialRescheduleClient
            appointmentId={appointmentId}
            consultantId={trial.subscriptionPlan.consultantProfileId}
            trialDurationMinutes={
              bookedSessionMinutes(detail.appointment.occurrences) ??
              trial.subscriptionPlan.trialDurationMinutes
            }
            title={trial.subscriptionPlan.title}
            backHref={backHref}
          />
        )}
      </DashboardViewportFill>
    );
  }

  // The picker draws the CONSULTANT's availability, and this route's params
  // carry no consultant — so it is resolved from the booking, here, rather
  // than shipped to the client to look up.
  const resolved = buildRescheduleSubject(detail);
  if (!resolved) notFound();

  return (
    <DashboardViewportFill className="gap-4">
      {/* The BOOKING now lives in the breadcrumb (RescheduleClient sets it via
          useSetBreadcrumbLabel); every reschedule page used to render an
          identical "Reschedule" heading, so the consultee could not tell
          which session they were moving (#1064). */}
      <div className="shrink-0">
        <PanelHeader
          description={
            resolved.consultantName
              ? `Choose a new time for your ${resolved.typeLabel.toLowerCase()} with ${resolved.consultantName}`
              : `Choose a new time for your ${resolved.typeLabel.toLowerCase()}`
          }
        />
      </div>

      {opsHref ? (
        <OperatorOpsHint href={opsHref} />
      ) : (
        <RescheduleClient
          appointmentId={appointmentId}
          title={resolved.title}
          typeLabel={resolved.typeLabel}
          subject={resolved.subject}
          backHref={backHref}
        />
      )}
    </DashboardViewportFill>
  );
}
