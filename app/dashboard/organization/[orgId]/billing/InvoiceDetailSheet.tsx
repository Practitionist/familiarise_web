"use client";

import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { ErrorState } from "@/components/dashboard/ErrorState";
import { KeyValueList, Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrencyAmount } from "@/utils/formatting";

import {
  INVOICE_STATUS,
  fetchInvoiceDetail,
  invoiceDetailUrl,
  type OrgInvoiceDetail,
} from "./billing-api";

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

function InvoiceBody({
  orgId,
  invoice,
}: Readonly<{ orgId: string; invoice: OrgInvoiceDetail }>) {
  const money = (paise: number) =>
    formatCurrencyAmount(paise, invoice.displayCurrency);
  const tax = invoice.igstPaise + invoice.cgstPaise + invoice.sgstPaise;
  // DRAFTs have no legal number yet; the PDF route refuses them.
  const hasPdf = invoice.status !== "DRAFT";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge {...INVOICE_STATUS[invoice.status]} />
        {hasPdf && (
          <Button asChild size="sm" variant="outline">
            <a
              href={`${invoiceDetailUrl(orgId, invoice.id)}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="mr-1.5 h-4 w-4" />
              Invoice PDF
            </a>
          </Button>
        )}
      </div>

      <KeyValueList
        items={[
          { label: "Issued", value: fmtDate(invoice.issuedAt) },
          { label: "Due", value: fmtDate(invoice.dueDate) },
          ...(invoice.paidAt
            ? [{ label: "Paid", value: fmtDate(invoice.paidAt) }]
            : []),
          ...(invoice.billingCycleStart
            ? [
                {
                  label: "Billing period",
                  value: `${fmtDate(invoice.billingCycleStart)} – ${fmtDate(invoice.billingCycleEnd)}`,
                },
              ]
            : []),
          ...(invoice.purchaseOrder
            ? [
                {
                  label: "Purchase order",
                  value: invoice.purchaseOrder.poNumber,
                },
              ]
            : []),
          { label: "Subtotal", value: money(invoice.subtotalPaise) },
          { label: "Tax", value: money(tax) },
          { label: "Total", value: money(invoice.totalPaise) },
        ]}
      />

      {invoice.lineItems.length > 0 && (
        <Section title="Lines">
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {invoice.lineItems.map((line) => (
              <li
                key={line.id}
                className="flex items-start justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  {line.description}
                  {line.quantity > 1 && (
                    <span className="text-muted-foreground">
                      {" "}
                      × {line.quantity}
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">
                  {money(line.unitPricePaise * line.quantity)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Credit notes">
        {invoice.creditNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No credit notes have been issued against this invoice.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {invoice.creditNotes.map((note) => (
              <li
                key={note.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="font-medium">{note.creditNoteNumber}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {fmtDate(note.issuedAt)} · {money(note.totalPaise)}
                  </span>
                  {note.reason && (
                    <span className="block text-xs text-muted-foreground">
                      {note.reason}
                    </span>
                  )}
                </span>
                <Button asChild size="sm" variant="ghost">
                  <a
                    href={`/api/organizations/${orgId}/billing-account/credit-notes/${note.id}/pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Download className="mr-1.5 h-4 w-4" />
                    PDF
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * Invoice detail (#1836 owner comment): the document, its lines and every
 * credit note issued against it, each with its PDF. Addressable as
 * `?invoice=<id>` so a finance teammate can share the link.
 */
export function InvoiceDetailSheet({
  orgId,
  invoiceId,
  onClose,
}: Readonly<{
  orgId: string;
  invoiceId: string | null;
  onClose: () => void;
}>) {
  const detail = useQuery({
    queryKey: ["org-invoice-detail", orgId, invoiceId],
    queryFn: () => fetchInvoiceDetail(orgId, invoiceId as string),
    enabled: invoiceId !== null,
  });

  let body: React.ReactNode;
  if (detail.isPending) {
    body = <Skeleton className="h-48 w-full" />;
  } else if (detail.isError) {
    body = (
      <ErrorState
        title="Couldn't load the invoice"
        onRetry={() => void detail.refetch()}
      />
    );
  } else {
    body = <InvoiceBody orgId={orgId} invoice={detail.data} />;
  }

  return (
    <Sheet
      open={invoiceId !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>
            {detail.data ? `Invoice ${detail.data.invoiceNumber}` : "Invoice"}
          </SheetTitle>
          <SheetDescription>
            The invoice, its lines and any credit notes issued against it.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6">{body}</div>
      </SheetContent>
    </Sheet>
  );
}
