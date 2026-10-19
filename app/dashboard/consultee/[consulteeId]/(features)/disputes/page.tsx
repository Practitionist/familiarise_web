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
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
} from "@/lib/support/disputes/protocol";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

/**
 * /dashboard/consultee/[consulteeId]/disputes — the buyer's claims.
 *
 * A buyer with an open claim should never have to go looking for it, so the
 * claim appears both here and as a banner on the payment it is about.
 */
export default async function DisputesPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = await params;
  await requirePersonalProfileAccess("consultee", consulteeId);
  const profile = await prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  });
  if (!profile) notFound();

  const disputes = await prisma.purchaseDispute.findMany({
    where: { buyerUserId: profile.userId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      referenceNumber: true,
      status: true,
      reason: true,
      round: true,
      amountAtStakePaise: true,
      respondentDueAt: true,
      escalatedAt: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  return (
    <DashboardContent>
      <PageHeader
        title="Your disputes"
        description="Claims you have raised, and where each one stands."
      />
      {disputes.length === 0 ? (
        <EmptyState
          title="No disputes"
          description="If a session did not go as agreed, open the payment and raise a dispute from there."
        />
      ) : (
        <ul className="divide-y rounded-lg border border-border">
          {disputes.map((dispute) => (
            <li
              key={dispute.id}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div className="space-y-1">
                <Link
                  href={`/dashboard/consultee/${consulteeId}/disputes/${dispute.referenceNumber}`}
                  className="text-sm font-medium underline underline-offset-4"
                >
                  {DISPUTE_REASON_LABEL[dispute.reason] ?? dispute.reason}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {dispute.referenceNumber} ·{" "}
                  {formatCurrencyAmount(
                    Number(dispute.amountAtStakePaise),
                    "INR",
                  )}{" "}
                  at stake · raised{" "}
                  {new Date(dispute.createdAt).toLocaleDateString()}
                </p>
              </div>
              <StatusBadge
                label={
                  DISPUTE_STATUS_LABEL[
                    dispute.status as keyof typeof DISPUTE_STATUS_LABEL
                  ] ?? dispute.status
                }
                tone={
                  dispute.status === "RESOLVED"
                    ? "success"
                    : dispute.status === "ESCALATED" ||
                        dispute.status === "UNDER_REVIEW"
                      ? "info"
                      : "warning"
                }
                size="sm"
              />
            </li>
          ))}
        </ul>
      )}
    </DashboardContent>
  );
}
