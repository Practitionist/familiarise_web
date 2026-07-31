import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import prisma from "@/lib/prisma";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { buildRescheduleSubject } from "@/lib/scheduling/slot-picker-subject";

import { RescheduleClient } from "./RescheduleClient";

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
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadDetail = cache(readAppointmentDetail);

/**
 * Names the booking, not the task. "Reschedule" on a backgrounded tab does not
 * say which of a consultee's sessions is being moved (#1064).
 */
export async function generateMetadata({
  params,
}: Readonly<PageProps>): Promise<Metadata> {
  const { appointmentId } = await params;
  const detail = await loadDetail(appointmentId).catch(() => null);
  const resolved = detail ? buildRescheduleSubject(detail) : null;
  if (!resolved) return { title: "Reschedule — Familiarise" };

  const who = resolved.consultantName ? ` with ${resolved.consultantName}` : "";
  return { title: `Reschedule: ${resolved.title}${who} — Familiarise` };
}

export default async function RescheduleAppointmentPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultee", consulteeId);

  const [detail, profile] = await Promise.all([
    loadDetail(appointmentId),
    prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    }),
  ]);
  if (!detail || !profile) notFound();

  // Binds the appointment to the URL's consultee; binding that consultee to
  // the SESSION is the guard above. Mirrors the detail page's check.
  const { appointment } = detail;
  const owns =
    appointment.consultation?.requestedBy?.id === consulteeId ||
    appointment.subscription?.requestedBy?.id === consulteeId ||
    appointment.trialSession?.consulteeProfile?.id === consulteeId ||
    appointment.slotsOfAppointment.some((slot) =>
      slot.user.some((user) => user.id === profile.userId),
    );
  if (!owns) notFound();

  // The picker draws the CONSULTANT's availability, and this route's params
  // carry no consultant — so it is resolved from the booking, here, rather
  // than shipped to the client to look up.
  const resolved = buildRescheduleSubject(detail);
  if (!resolved) notFound();

  const backHref = `/dashboard/consultee/${consulteeId}/appointments`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* The BOOKING is the h1, the task is the line under it — every
          reschedule page rendered an identical "Reschedule" heading, so the
          consultee could not tell which session they were moving (#1064). */}
      <DashboardHeader
        title={resolved.title}
        subtitle={
          resolved.consultantName
            ? `Choose a new time for your ${resolved.typeLabel.toLowerCase()} with ${resolved.consultantName}`
            : `Choose a new time for your ${resolved.typeLabel.toLowerCase()}`
        }
      />

      <Link
        href={backHref}
        className="self-start text-sm font-medium underline underline-offset-4"
      >
        Back to appointments
      </Link>

      <RescheduleClient
        appointmentId={appointmentId}
        title={resolved.title}
        typeLabel={resolved.typeLabel}
        subject={resolved.subject}
        backHref={backHref}
      />
    </div>
  );
}
