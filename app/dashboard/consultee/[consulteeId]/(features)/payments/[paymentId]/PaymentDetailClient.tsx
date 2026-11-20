"use client";

import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { Section, KeyValueList } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { toneBadge } from "@/lib/dashboard/money-state";
import { caseKeyOf } from "@/lib/support/case-key";
import { formatFundingBreakdown } from "@/lib/appointments/payment-display";
import { humanizeEnum, toneTextClass } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { ConsulteePaymentDetail } from "@/lib/data/consultee-payment-detail";

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});
const formatWhen = (value: Date | string) => DATE_TIME.format(new Date(value));

type Money = (paise: number) => string;

// An expired gateway order can still capture late; only one never minted provably charged nothing.
const neverCharged = (detail: ConsulteePaymentDetail) =>
  detail.row.status === "EXPIRED" && !detail.gatewayOrderMinted;

function chargeFacts(detail: ConsulteePaymentDetail, money: Money) {
  const { row, moneyState } = detail;
  return [
    ...(detail.showAmount && moneyState.state !== "SPONSORED"
      ? [
          {
            label: neverCharged(detail) ? "Would have been" : "Amount",
            value: money(row.amount),
            hint:
              row.taxAmount > 0
                ? `Includes ${money(row.taxAmount)} GST`
                : undefined,
          },
        ]
      : []),
    ...detail.coPays.map((c, i) => ({
      label: detail.coPays.length > 1 ? `Your share ${i + 1}` : "Your share",
      value: formatCurrencyAmount(c.amountPaise, c.currency),
    })),
    ...(detail.showAmount &&
    row.status === "SUCCEEDED" &&
    row.fundingBreakdown.length > 1
      ? [
          {
            label: "Paid with",
            value: formatFundingBreakdown(row.fundingBreakdown, row.currency),
          },
        ]
      : []),
    ...(row.discount
      ? [
          {
            label: "Discount",
            value:
              detail.showAmount && row.discountBreakdown.codeDiscountPaise > 0
                ? `Code ${row.discount.code} · \u2212${money(row.discountBreakdown.codeDiscountPaise)}`
                : `Code ${row.discount.code}`,
          },
        ]
      : []),
    ...(detail.showAmount && row.discountBreakdown.welcomeDiscountPaise > 0
      ? [
          {
            label: "Welcome discount",
            value: `\u2212${money(row.discountBreakdown.welcomeDiscountPaise)}`,
            hint: "Your referral welcome discount, taken off before GST",
          },
        ]
      : []),
    ...(row.refundedPaise > 0 && detail.showAmount
      ? [{ label: "Refunded", value: money(row.refundedPaise) }]
      : []),
    { label: "Payer", value: detail.payer },
    { label: "Date", value: formatWhen(row.createdAt) },
    { label: "For", value: `${row.planTitle} with ${row.consultantName}` },
  ];
}

function chargeDocuments(detail: ConsulteePaymentDetail) {
  return [
    ...(detail.invoicePdfHref && detail.taxDocumentsAvailable
      ? [
          {
            key: "invoice",
            label: "Tax invoice (PDF)",
            href: detail.invoicePdfHref,
          },
        ]
      : []),
    ...(detail.receiptHref
      ? [{ key: "receipt", label: "Receipt", href: detail.receiptHref }]
      : []),
    ...(detail.taxDocumentsAvailable ? detail.creditNotes : []).map((note) => ({
      key: note.id,
      label: `Credit note ${note.number} (PDF)`,
      href: note.href,
    })),
  ];
}

/**
 * "What happened to this charge?": the money line and its facts,
 * the refund timeline with arrival times, every document for it, and the
 * same "Problem with this charge" door the appointment page has, offered only
 * when money was taken or may have been.
 */
export function PaymentDetailClient({
  consulteeId,
  detail,
}: Readonly<{ consulteeId: string; detail: ConsulteePaymentDetail }>) {
  const { row, moneyState } = detail;
  useSetBreadcrumbLabel(row.planTitle);
  const basePath = `/dashboard/consultee/${consulteeId}`;
  const money = (paise: number) => formatCurrencyAmount(paise, row.currency);
  // The booking's request page, opened on the payment intent; a
  // charge with no booking goes to the Platform tab's request form.
  const helpHref = row.appointmentId
    ? `${basePath}/support/requests/${caseKeyOf({ kind: "booking", id: row.appointmentId })}?intent=PAYMENT_STATUS`
    : `${basePath}/support?context=platform`;

  const facts = chargeFacts(detail, money);
  const nothingCharged =
    moneyState.state === "FREE" ||
    (neverCharged(detail) && detail.creditHeldPaise === 0);
  const taxDocsPending =
    !detail.gstUnregistered &&
    !detail.taxDocumentsAvailable &&
    (detail.invoicePdfHref !== null ||
      detail.creditNotes.length > 0 ||
      row.status === "SUCCEEDED");
  const documents = chargeDocuments(detail);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        back={{ href: `${basePath}/payments?tab=history`, label: "Billing" }}
        title={row.planTitle}
        description={
          moneyState.line === moneyState.label ? undefined : moneyState.line
        }
        meta={
          <StatusBadge
            {...toneBadge(moneyState.tone, moneyState.label)}
            size="sm"
          />
        }
        actions={
          nothingCharged ? undefined : (
            <Button variant="outline" size="sm" asChild>
              <Link href={helpHref}>
                <LifeBuoy className="mr-1.5 h-4 w-4" />
                Problem with this charge
              </Link>
            </Button>
          )
        }
      />

      <Section title="Charge" variant="card">
        <KeyValueList items={facts} />
        {moneyState.detail && (
          <p className="mt-3 text-xs text-muted-foreground">
            {moneyState.detail}
          </p>
        )}
      </Section>

      {detail.refunds.length > 0 && (
        <Section title="Refund details" variant="card">
          <ul className="divide-y divide-border">
            {detail.refunds.map((refund) => (
              <li key={refund.id} className="space-y-1 py-3 text-sm first:pt-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">
                    {formatCurrencyAmount(refund.amountPaise, refund.currency)}
                  </span>
                  <span className="text-muted-foreground">
                    {humanizeEnum(refund.status)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Requested {formatWhen(refund.createdAt)} · Updated{" "}
                  {formatWhen(refund.updatedAt)}
                </p>
                {refund.failureNotice && (
                  <p className="text-xs text-foreground">
                    {refund.failureNotice}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Refund reference for support:{" "}
                  <span className="font-mono">{refund.gatewayRefundId}</span>
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.refundTimeline.length > 0 && (
        <Section title="Refunds" variant="card">
          <ol className="space-y-3">
            {detail.refundTimeline.map((step, i) => (
              <li key={`${step.label}-${i}`} className="flex gap-3 text-sm">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full bg-current ${toneTextClass(step.tone)}`}
                />
                <div>
                  <p className="text-foreground">{step.label}</p>
                  {step.at && (
                    <p className="text-xs text-muted-foreground">
                      {formatWhen(step.at)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section title="Documents" variant="card">
        {taxDocsPending && (
          <p className="mb-2 text-sm text-muted-foreground">
            Your tax invoice is not available yet. It will appear here once it
            is ready.
          </p>
        )}
        {detail.gstUnregistered && row.status === "SUCCEEDED" && (
          <p className="mb-2 text-sm text-muted-foreground">
            No GST was charged on this payment, so it has a receipt rather than
            a tax invoice.
          </p>
        )}
        {documents.length === 0 ? (
          !taxDocsPending &&
          !detail.gstUnregistered && (
            <p className="text-sm text-muted-foreground">
              No documents for this charge yet. A tax invoice is issued once a
              payment goes through.
            </p>
          )
        ) : (
          <ul className="space-y-2 text-sm">
            {documents.map((doc) => (
              <li key={doc.key}>
                <a
                  href={doc.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {doc.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {row.appointmentId && (
        <Section title="Booking" variant="card">
          <Link
            href={`${basePath}/appointments/${row.appointmentId}`}
            className="text-sm font-medium text-foreground underline underline-offset-4"
          >
            Open the booking
          </Link>
        </Section>
      )}
    </div>
  );
}
