"use client";

import { useState } from "react";
import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Section, KeyValueList } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";
import { toneBadge } from "@/lib/dashboard/money-state";
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

/**
 * #1527 Q5 — "What happened to this charge?": the money line and its facts,
 * the refund timeline with arrival times, every document for it, and the
 * same "Problem with this charge" door the appointment page has.
 */
export function PaymentDetailClient({
  consulteeId,
  detail,
}: Readonly<{ consulteeId: string; detail: ConsulteePaymentDetail }>) {
  const [helpOpen, setHelpOpen] = useState(false);
  const { row, moneyState } = detail;
  const basePath = `/dashboard/consultee/${consulteeId}`;
  const money = (paise: number) => formatCurrencyAmount(paise, row.currency);

  const facts = [
    ...(detail.showAmount && moneyState.state !== "SPONSORED"
      ? [
          {
            label: "Amount",
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
    ...(detail.showAmount && detail.legs.length > 1
      ? [
          {
            label: "Paid with",
            value: detail.legs
              .map((l) => `${humanizeEnum(l.source)} ${money(l.amountPaise)}`)
              .join(" · "),
          },
        ]
      : []),
    ...(row.discount
      ? [{ label: "Discount", value: `Code ${row.discount.code}` }]
      : []),
    ...(row.refundedPaise > 0 && detail.showAmount
      ? [{ label: "Refunded", value: money(row.refundedPaise) }]
      : []),
    { label: "Date", value: formatWhen(row.createdAt) },
    { label: "For", value: `${row.planTitle} with ${row.consultantName}` },
  ];

  const documents = [
    ...(detail.invoicePdfHref
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
    ...detail.creditNotes.map((note) => ({
      key: note.id,
      label: `Credit note ${note.number} (PDF)`,
      href: note.href,
    })),
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        back={{ href: `${basePath}/payments?tab=history`, label: "Payments" }}
        title={row.planTitle}
        description={moneyState.line}
        meta={
          <StatusBadge
            {...toneBadge(moneyState.tone, moneyState.label)}
            size="sm"
          />
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => setHelpOpen(true)}>
            <LifeBuoy className="mr-1.5 h-4 w-4" />
            Problem with this charge
          </Button>
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
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No documents for this charge yet. A tax invoice is issued once a
            payment goes through.
          </p>
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

      {row.appointmentId ? (
        <SupportThreadSheet
          appointmentId={row.appointmentId}
          open={helpOpen}
          onOpenChange={setHelpOpen}
          seedCategory="PAYMENT_STATUS"
          appointmentHref={`${basePath}/appointments/${row.appointmentId}`}
        />
      ) : (
        helpOpen && (
          <p className="text-sm text-muted-foreground">
            This charge has no booking to attach a request to.{" "}
            <Link
              href={`${basePath}/support?tab=requests`}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Open Help &amp; support
            </Link>
            .
          </p>
        )
      )}
    </div>
  );
}
