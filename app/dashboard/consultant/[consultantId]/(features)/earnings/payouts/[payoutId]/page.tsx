import { notFound } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";

import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Section, KeyValueList } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readConsultantPayoutDetail } from "@/lib/data/consultant-payout-detail";
import {
  PAYOUT_ZONE,
  derivePayoutPresentation,
  presentationBadge,
} from "@/lib/dashboard/earnings-state";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

type PageProps = {
  params: Promise<{ consultantId: string; payoutId: string }>;
};

const when = (d: Date) =>
  formatInTimeZone(d, PAYOUT_ZONE, "d MMM yyyy, h:mm a");
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/**
 * /dashboard/consultant/[consultantId]/earnings/payouts/[payoutId] — ownership
 * is enforced here and again in the read's WHERE; anything else is a 404.
 */
export default async function PayoutDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, payoutId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);

  const payout = await readConsultantPayoutDetail({
    payoutId,
    consultantProfileId: consultantId,
  });
  if (!payout) notFound();

  const money = (paise: number) => formatCurrencyAmount(paise, payout.currency);
  const presentation = derivePayoutPresentation({
    status: payout.status,
    amount: payout.amountPaise,
    tdsDeducted: payout.tdsPaise,
    netAmount: payout.netPaise,
    tdsRateAppliedBps: payout.tdsRateBps,
    processedAt: payout.processedAt,
    gatewayUtr: payout.utr,
    failureReason: payout.failure,
    createdAt: payout.createdAt,
  });

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        back={{
          href: `/dashboard/consultant/${consultantId}/earnings`,
          label: "Earnings",
        }}
        title={`Payout of ${money(payout.netPaise)}`}
        description={presentation.line}
        meta={<StatusBadge {...presentationBadge(presentation)} size="sm" />}
      />

      <Section title="Amounts" variant="card">
        <KeyValueList
          items={[
            { label: "Payout amount", value: money(payout.amountPaise) },
            {
              label: payout.tdsRateBps
                ? `TDS deducted (${pct(payout.tdsRateBps)}${payout.tdsFinancialYear ? `, FY ${payout.tdsFinancialYear}` : ""})`
                : "TDS deducted",
              value: money(payout.tdsPaise),
            },
            { label: "Net to your account", value: money(payout.netPaise) },
            { label: "Method", value: humanizeEnum(payout.method) },
            ...(payout.utr ? [{ label: "UTR", value: payout.utr }] : []),
          ]}
        />
      </Section>

      <Section title="Status" variant="card">
        <ol className="space-y-3">
          {payout.timeline.map((step) => (
            <li key={step.label} className="flex gap-3 text-sm">
              <span
                aria-hidden
                className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-foreground"
              />
              <div>
                <p className="text-foreground">{step.label}</p>
                {step.at && (
                  <p className="text-xs text-muted-foreground">
                    {when(step.at)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Earnings in this payout" variant="card">
        {payout.earnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No earnings are linked to this payout.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {payout.earnings.map((e) => (
              <li
                key={e.id}
                className="flex items-start justify-between gap-3 py-3 text-sm first:pt-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-foreground">{e.offering}</p>
                  <p className="text-xs text-muted-foreground">
                    Paid by client{" "}
                    {formatInTimeZone(e.paymentDate, PAYOUT_ZONE, "d MMM yyyy")}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-medium text-foreground">
                    {money(e.sharePaise)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    of {money(e.grossPaise)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
