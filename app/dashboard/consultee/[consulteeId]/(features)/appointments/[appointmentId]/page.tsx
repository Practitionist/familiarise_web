import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import prisma from "@/lib/prisma";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import DetailPageClient from "./DetailPageClient";

type PageProps = {
  params: Promise<{ consulteeId: string; appointmentId: string }>;
};

export default async function AppointmentDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;

  const [detail, profile] = await Promise.all([
    readAppointmentDetail(appointmentId),
    prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    }),
  ]);
  if (!detail || !profile) notFound();

  // Ownership: the route's consultee must be a party to this appointment
  // (requester, trial consultee, or slot participant). The dashboard layout
  // already verifies the session user owns `consulteeId`.
  const { appointment } = detail;
  const owns =
    appointment.consultation?.requestedBy?.id === consulteeId ||
    appointment.subscription?.requestedBy?.id === consulteeId ||
    appointment.trialSession?.consulteeProfile?.id === consulteeId ||
    appointment.slotsOfAppointment.some((slot) =>
      slot.user.some((u) => u.id === profile.userId),
    );
  if (!owns) notFound();

  const queryClient = new QueryClient();
  queryClient.setQueryData(["appointment-detail", appointmentId], detail);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DetailPageClient
        consulteeId={consulteeId}
        appointmentId={appointmentId}
      />
    </HydrationBoundary>
  );
}
