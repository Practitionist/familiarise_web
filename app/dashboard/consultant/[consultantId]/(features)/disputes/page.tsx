import { notFound } from "next/navigation";
import Link from "next/link";

import prisma from "@/lib/prisma";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
} from "@/lib/support/disputes/protocol";
import { respondentWindowPassed } from "@/lib/support/disputes/deadlines";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

/**
 * /dashboard/consultant/[consultantId]/disputes — claims this expert must
 * answer.
 *
 * The claim is a duty, not a queue: the expert has a contractual window to
 * answer, and the dispute escalates to the platform when it passes. So the
 * page leads with the deadline, not with the amount.
 */
export default async function DisputesPage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);
  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantId },
    select: { userId: true },
  });
  if (!profile) notFound();

  const disputes = await prisma.purchaseDispute.findMany({
    where: { respondentUserId: profile.userId },
    orderBy: [{ respondentDueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      referenceNumber: true,
      status: true,
      reason: true,
      round: true,
      amountAtStakePaise: true,
      respondentDueAt: true,
      respondentRespondedAt: true,
      buyerDecision: true,
      escalatedAt: true,
      resolvedAt: true,
      createdAt: true,
      buyer: { select: { name: true } },
    },
  });

  const now = new Date();
  const needsAnswer = disputes.filter(
    (d) => d.status === "OPEN" && !respondentWindowPassed(d.respondentDueAt, now),
  );

  return (
    <>
      <DashboardHeader
        title="Disputes"
        description={
          needsAnswer.length > 0
            ? `You have ${needsAnswer.length} claim${needsAnswer.length === 1 ? "" : "s"} to answer.`
            : "Claims a learner has raised about your sessions."
        }
      />
      <DashboardContent>
        {disputes.length === 0 ? (
          <EmptyState
            title="No disputes"
            description="When a learner raises a claim about a session you delivered, it appears here with a deadline to answer."
          />
        ) : (
          <ul className="divide-y rounded-lg border border-border">
            {disputes.map((dispute) => {
              const overdue =
                dispute.status === "OPEN" &&
                respondentWindowPassed(dispute.respondentDueAt, now);
              return (
                <li
                  key={dispute.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div className="space-y-1">
                    <Link
                      href={`/dashboard/consultant/${consultantId}/disputes/${dispute.referenceNumber}`}
                      className="text-sm font-medium underline underline-offset-4"
                    >
                      {DISPUTE_REASON_LABEL[dispute.reason] ?? dispute.reason}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {dispute.referenceNumber} · raised by{" "}
                      {dispute.buyer.name} ·{" "}
                      {formatCurrencyAmount(
                        Number(dispute.amountAtStakePaise),
                        "INR",
                      )}{" "}
                      at stake
                    </p>
                    {dispute.status === "OPEN" && dispute.respondentDueAt && (
                      <p
                        className={
                          overdue
                            ? "text-xs font-medium text-destructive"
                            : "text-xs text-muted-foreground"
                        }
                      >
                        {overdue
                          ? "Your window to answer has passed — our team has taken this over."
                          : `Answer by ${new Date(dispute.respondentDueAt).toLocaleDateString()}.`}
                      </p>
                    )}
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
                          : overdue
                            ? "critical"
                            : "warning"
                    }
                    size="sm"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </DashboardContent>
    </>
  );
}
