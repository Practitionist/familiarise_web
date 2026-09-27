import { notFound } from "next/navigation";
import prisma from "@/lib/prisma";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readConsulteePaymentDetail } from "@/lib/data/consultee-payment-detail";
import { PaymentDetailClient } from "./PaymentDetailClient";

type PageProps = {
  params: Promise<{ consulteeId: string; paymentId: string }>;
};

/**
 * /dashboard/consultee/[consulteeId]/payments/[paymentId] — #1527 Q5.
 *
 * Ownership is enforced HERE, not by the layout (a client component): the
 * session must own the profile, and the read only answers for a charge that
 * profile's user paid. Anything else is a 404.
 */
export default async function PaymentDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, paymentId } = await params;
  await requirePersonalProfileAccess("consultee", consulteeId);
  const profile = await prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  });
  if (!profile) notFound();

  const detail = await readConsulteePaymentDetail({
    paymentId,
    consulteeId,
    userId: profile.userId,
  });
  if (!detail) notFound();

  return <PaymentDetailClient consulteeId={consulteeId} detail={detail} />;
}
