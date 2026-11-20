import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import prisma from "@/lib/prisma";
import {
  readAppointmentDetail,
  scopeAppointmentDetail,
  viewerMayWithdrawReschedule,
} from "@/lib/data/appointment-detail";
import { managesGroupPlanAsNamedExpert } from "@/lib/enterprise/membership-guards";
import DetailPageClient from "./DetailPageClient";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { viewerSeatReleased } from "@/lib/appointments/presentation-input";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { getSession } from "@/lib/auth-server";
import { getViewerZone } from "@/lib/time/viewer-zone-server";

type PageProps = {
  params: Promise<{ consulteeId: string; appointmentId: string }>;
};

export default async function AppointmentDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultee", consulteeId);

  const [detail, profile] = await Promise.all([
    readAppointmentDetail(appointmentId),
    prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    }),
  ]);
  if (!detail || !profile) notFound();

  // Ownership: the route's consultee must be a party to this appointment
  // (requester, trial consultee, or slot participant). This binds the
  // appointment to the URL's consultee; binding that consultee to the SESSION
  // is the guard above — it used to cite the dashboard layout, which is a
  // client component and so had already been overtaken by this render.
  const { appointment } = detail;
  const owns =
    appointment.consultation?.requestedBy?.id === consulteeId ||
    appointment.subscription?.requestedBy?.id === consulteeId ||
    appointment.trial?.consulteeProfile?.id === consulteeId ||
    appointment.participants.some((seat) => seat.userId === profile.userId) ||
    // A payer whose seat was released (e.g. after a refund) still opens the
    // booking their payment links to; the rows are scoped to their own below.
    appointment.payment.some((p) => p.userId === profile.userId);
  if (!owns) notFound();
  // A released seat renders its own plain state, never the event it left.
  if (viewerSeatReleased(detail, profile.userId)) {
    return <NoLongerRegistered consulteeId={consulteeId} />;
  }

  // One zone for the server render and hydration (#418, #1527 QA).
  const viewerZone = await getViewerZone();
  const queryClient = new QueryClient();
  // The attending side: hydrate only this attendee's own payment rows, the
  // same shape the API route answers, or the first paint would show every
  // other attendee's money before the refetch replaced it.
  queryClient.setQueryData(
    ["appointment-detail", appointmentId],
    scopeAppointmentDetail(detail, {
      userId: profile.userId,
      managesGroupPlan: await managesGroupPlanAsNamedExpert(
        prisma,
        appointment,
        profile.userId,
      ),
      mayWithdrawReschedule: await viewerMayWithdrawReschedule(
        detail,
        await getSession(),
      ),
    }),
  );

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DetailPageClient
        consulteeId={consulteeId}
        appointmentId={appointmentId}
        viewerZone={viewerZone.zone}
      />
    </HydrationBoundary>
  );
}

function NoLongerRegistered({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-2xl border border-border bg-card p-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        You are no longer registered for this event
      </h1>
      <p className="text-sm text-muted-foreground">
        Your place was released. The booking is listed under Cancelled in your
        appointments.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link
          href={`/dashboard/consultee/${consulteeId}/appointments?tab=cancelled`}
        >
          Go to Appointments
        </Link>
      </Button>
    </div>
  );
}
