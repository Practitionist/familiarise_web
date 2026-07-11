import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import DetailPageClient from "./DetailPageClient";

type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
};

export default async function AppointmentDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, appointmentId } = await params;

  const detail = await readAppointmentDetail(appointmentId);
  if (!detail) notFound();

  // Ownership: the route's consultant must own the plan or be an ACCEPTED
  // collaborator. The dashboard layout already verifies the session user
  // owns `consultantId`.
  const { appointment } = detail;
  const planOwnerIds = [
    appointment.consultation?.consultationPlan?.consultantProfile?.id,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.id,
    appointment.webinar?.webinarPlan?.consultantProfile?.id,
    appointment.class?.classPlan?.consultantProfile?.id,
    appointment.trialSession?.subscriptionPlan?.consultantProfile?.id,
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.id,
    ),
    ...(appointment.class?.classPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.id,
    ),
  ];
  if (!planOwnerIds.includes(consultantId)) notFound();

  const queryClient = new QueryClient();
  queryClient.setQueryData(["appointment-detail", appointmentId], detail);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DetailPageClient
        consultantId={consultantId}
        appointmentId={appointmentId}
      />
    </HydrationBoundary>
  );
}
