/**
 * /dashboard/organization/[orgId]/my-arrangement — EXPERT's per-org view.
 *
 * The org's RateCard governs WHO gets paid WHAT for sessions hosted via
 * this org's brand. An EXPERT must be able to confirm:
 *   1. Where their share of sessions actually goes — `payoutRecipient`
 *      (`SELF` flows to their personal account; `ORGANIZATION` is
 *      absorbed by the org and they get a cut later via internal split).
 *   2. The exact bps split that applies right now — `RateCard` for the
 *      org (default + any consultant-category override).
 *   3. Their recent earnings via this org so they can reconcile the
 *      personal earnings dashboard against the org-routed flow.
 *
 * Read-only. Mutations (changing payout arrangement, accepting a new
 * RateCard) live on operator pages — an EXPERT can't self-flip those.
 */

import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { formatCurrencyAmount } from "@/utils/formatting";

const PAYOUT_RECIPIENT_LABEL: Record<string, string> = {
  SELF: "You — paid directly",
  ORGANIZATION: "The organisation — they distribute internally",
};

const PAYOUT_RECIPIENT_DESCRIPTION: Record<string, string> = {
  SELF:
    "Your share of every session hosted via this org flows directly to your personal payout account. Manage that on your personal dashboard.",
  ORGANIZATION:
    "Your share of every session hosted via this org is absorbed by the organisation. They handle the internal distribution to you offline.",
};

export default async function MyArrangementPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }
  // Pages under canHost=false orgs (pure sponsors) don't host sessions
  // and have no RateCards / earnings — surface 404 to keep the URL
  // tree honest.
  if (!access.org.canHost) {
    notFound();
  }

  const now = new Date();
  const member = access.member;

  // Active org-default RateCard (no contract, no plan-type filter — the
  // catch-all card). Future: surface consultant-category overrides if
  // the schema grows that scope.
  const orgDefaultCard = await prisma.rateCard.findFirst({
    where: {
      ownerOrgId: orgId,
      planType: null,
      planId: null,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });

  const payoutAccount =
    member.payoutRecipient === "ORGANIZATION"
      ? await prisma.organizationPayoutAccount.findUnique({
          where: { organizationId: orgId },
          select: { bankName: true, accountNumberLast4: true, status: true },
        })
      : null;

  // Recent earnings for this consultant on this org's hosted payments.
  // For HOST orgs the payment itself has organizationId=null (the learner
  // pays personally); the org relationship lives on OrganizationEarnings.
  // We join via paymentId: find OrgEarnings rows for this org, then fetch
  // the matching ConsultantEarnings rows for this consultant.
  const orgEarningPaymentIds = member.consultantProfileId
    ? (
        await prisma.organizationEarnings.findMany({
          where: { organizationId: orgId },
          select: { paymentId: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      ).map((r) => r.paymentId)
    : [];

  const earnings =
    orgEarningPaymentIds.length > 0
      ? await prisma.consultantEarnings.findMany({
          where: {
            consultantProfileId: member.consultantProfileId!,
            paymentId: { in: orgEarningPaymentIds },
          },
          orderBy: { id: "desc" },
          take: 20,
          include: {
            payment: {
              select: {
                id: true,
                createdAt: true,
                currency: true,
                appointment: {
                  select: { id: true, appointmentType: true },
                },
              },
            },
          },
        })
      : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My Arrangement</h1>
        <p className="text-sm text-muted-foreground mt-1">
          How {access.org.name} compensates you for sessions hosted under their
          brand.
        </p>
      </header>

      {/* Payout arrangement */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-medium">Payout arrangement</h2>
            <p className="mt-1 text-sm">
              {PAYOUT_RECIPIENT_LABEL[member.payoutRecipient] ??
                member.payoutRecipient}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {PAYOUT_RECIPIENT_DESCRIPTION[member.payoutRecipient]}
            </p>
          </div>
          <span className="rounded-full border px-2.5 py-0.5 text-xs">
            {member.payoutRecipient}
          </span>
        </div>

        {member.payoutRecipient === "ORGANIZATION" && payoutAccount && (
          <div className="mt-4 rounded-md border-l-2 border-primary bg-muted/40 p-3 text-sm">
            <p className="font-medium">Organisation payout account</p>
            <p className="mt-1 text-muted-foreground">
              {payoutAccount.bankName} · ••••{payoutAccount.accountNumberLast4} ·
              status: {payoutAccount.status.toLowerCase().replace(/_/g, " ")}
            </p>
          </div>
        )}

        {member.payoutRecipient === "SELF" && (
          <p className="mt-4 text-xs text-muted-foreground">
            Manage your personal payout account from{" "}
            <Link
              href="/dashboard"
              className="underline text-primary"
            >
              your personal dashboard
            </Link>
            .
          </p>
        )}
      </section>

      {/* RateCard split */}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="font-medium">Revenue split</h2>
        {orgDefaultCard ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              The default split for sessions hosted via {access.org.name}.
              In effect since{" "}
              {orgDefaultCard.effectiveFrom.toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
              .
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <SplitCard
                label="Platform"
                bps={orgDefaultCard.platformBps}
              />
              <SplitCard
                label="Organisation"
                bps={orgDefaultCard.orgBps}
              />
              <SplitCard
                label="You (consultant)"
                bps={orgDefaultCard.consultantBps}
                emphasised
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Illustration on a ₹1,000 session: platform takes{" "}
              {formatCurrencyAmount(
                Math.round(orgDefaultCard.platformBps * 10),
                "INR",
              )}
              , the organisation takes{" "}
              {formatCurrencyAmount(
                Math.round(orgDefaultCard.orgBps * 10),
                "INR",
              )}
              , your share is{" "}
              {formatCurrencyAmount(
                Math.round(orgDefaultCard.consultantBps * 10),
                "INR",
              )}
              .
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No active rate card configured for this organisation yet. Reach out
            to your org administrator if you expect to host sessions soon.
          </p>
        )}
      </section>

      {/* Recent earnings */}
      {earnings.length > 0 && (
        <section>
          <h2 className="text-lg font-medium mb-3">Recent earnings on this org</h2>
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium text-right">Gross</th>
                  <th className="px-4 py-2 font-medium text-right">
                    Your share
                  </th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {earnings.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="px-4 py-2">
                      {e.payment.createdAt.toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-2 lowercase">
                      {e.payment.appointment?.appointmentType ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {formatCurrencyAmount(e.grossAmount, "INR")}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {formatCurrencyAmount(e.consultantShare, "INR")}
                    </td>
                    <td className="px-4 py-2 text-xs">{e.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {member.payoutRecipient === "ORGANIZATION" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Your share figures above show the consultant cut per the rate
              card. Because your payout is routed to the organisation, the
              actual cash flow to you happens internally — confirm with your
              org administrator.
            </p>
          )}
        </section>
      )}

      {!member.consultantProfileId && (
        <div className="rounded-lg border bg-muted/40 p-4 text-sm">
          You don't have a consultant profile yet. Once you create one on your
          personal dashboard, sessions you host under this org will show up
          here.
        </div>
      )}
    </div>
  );
}

function SplitCard({
  label,
  bps,
  emphasised,
}: {
  label: string;
  bps: number;
  emphasised?: boolean;
}) {
  const pct = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1);
  return (
    <div
      className={
        "rounded-md border p-4 " +
        (emphasised
          ? "border-primary bg-primary/5"
          : "border-border bg-card")
      }
    >
      <p className="text-2xl font-semibold">{pct}%</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  );
}
