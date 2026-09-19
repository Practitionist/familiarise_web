import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import {
  readAppointmentDetail,
  scopeAppointmentDetail,
} from "@/lib/data/appointment-detail";
import DetailPageClient from "./DetailPageClient";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
};

export default async function AppointmentDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, appointmentId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  //
  // Deliberately sequential, NOT Promise.all: the guard must SETTLE before
  // the detail read starts. Firing both concurrently would run the query
  // against someone else's rows before the ownership check resolves — the
  // exact bug this file's comment and the ssr-ownership guard test pin
  // against. The round trip this costs is the price of the invariant.
  const access = await requirePersonalProfileAccess("consultant", consultantId);

  const detail = await readAppointmentDetail(appointmentId);

  if (!detail) notFound();

  // Ownership: the route's consultant must own the plan or be an ACCEPTED
  // collaborator. This check binds the appointment to the URL's consultant;
  // binding that consultant to the SESSION is the guard above — it used to
  // cite the dashboard layout, which is a client component and so had already
  // been overtaken by this render.
  const { appointment } = detail;
  const planOwnerIds = [
    appointment.consultation?.consultationPlan?.consultantProfile?.id,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.id,
    appointment.webinar?.webinarPlan?.consultantProfile?.id,
    appointment.class?.classPlan?.consultantProfile?.id,
    appointment.trial?.subscriptionPlan?.consultantProfile?.id,
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.id,
    ),
    ...(appointment.class?.classPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.id,
    ),
  ];
  if (!planOwnerIds.includes(consultantId)) notFound();

  const queryClient = new QueryClient();
  // The same shape the API route answers: the host reads every seat, but a
  // receipt pointer travels only on rows the viewer paid (or to staff).
  queryClient.setQueryData(
    ["appointment-detail", appointmentId],
    scopeAppointmentDetail(detail, access.userId, access.isInspecting),
  );

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DetailPageClient
        consultantId={consultantId}
        appointmentId={appointmentId}
      />
    </HydrationBoundary>
  );
}
