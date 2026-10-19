import { notFound } from "next/navigation";

import prisma from "@/lib/prisma";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DisputeTimeline } from "@/components/support/DisputeTimeline";
import { isDisputeReference } from "@/lib/support/disputes/reference";

type PageProps = {
  params: Promise<{ consultantId: string; referenceNumber: string }>;
};

/**
 * /dashboard/consultant/[consultantId]/disputes/[referenceNumber] — the
 * respondent's answer.
 *
 * The read proves the caller is the respondent before rendering, so a
 * reference number is not a way to read somebody else's claim.
 */
export default async function DisputeDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, referenceNumber } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);
  if (!isDisputeReference(referenceNumber)) notFound();

  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantId },
    select: { userId: true },
  });
  if (!profile) notFound();

  const dispute = await prisma.purchaseDispute.findFirst({
    where: { referenceNumber, respondentUserId: profile.userId },
    select: { id: true },
  });
  if (!dispute) notFound();

  return (
    <>
      <DashboardHeader
        title="Dispute"
        description={`Reference ${referenceNumber}`}
        back={{
          href: `/dashboard/consultant/${consultantId}/disputes`,
          label: "Disputes",
        }}
      />
      <DashboardContent>
        <div className="rounded-lg border border-border p-4">
          <DisputeTimeline
            referenceNumber={referenceNumber}
            disputeHref={`/dashboard/consultant/${consultantId}/disputes`}
          />
        </div>
      </DashboardContent>
    </>
  );
}
