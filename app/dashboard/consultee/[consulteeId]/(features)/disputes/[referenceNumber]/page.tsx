import { notFound } from "next/navigation";
import Link from "next/link";

import prisma from "@/lib/prisma";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { DisputeTimeline } from "@/components/support/DisputeTimeline";
import { formatCurrencyAmount } from "@/utils/formatting";
import { isDisputeReference } from "@/lib/support/disputes/reference";

type PageProps = {
  params: Promise<{ consulteeId: string; referenceNumber: string }>;
};

/**
 * /dashboard/consultee/[consulteeId]/disputes/[referenceNumber] — one claim.
 *
 * The page reads the dispute to prove the caller owns it before rendering
 * the timeline, so a reference number is not a way to read somebody else's
 * case.
 */
export default async function DisputeDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, referenceNumber } = await params;
  await requirePersonalProfileAccess("consultee", consulteeId);
  if (!isDisputeReference(referenceNumber)) notFound();

  const profile = await prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  });
  if (!profile) notFound();

  const dispute = await prisma.purchaseDispute.findFirst({
    where: { referenceNumber, buyerUserId: profile.userId },
    select: { id: true },
  });
  if (!dispute) notFound();

  return (
    <DashboardContent>
      <PageHeader
        title="Dispute"
        description={`Reference ${referenceNumber}`}
        back={{
          href: `/dashboard/consultee/${consulteeId}/disputes`,
          label: "Your disputes",
        }}
      />
      <div className="rounded-lg border border-border p-4">
        <DisputeTimeline
          referenceNumber={referenceNumber}
          disputeHref={`/dashboard/consultee/${consulteeId}/disputes`}
        />
      </div>
    </DashboardContent>
  );
}
