"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "@/app/checkout/plans/utils";
import { useSession } from "@/lib/auth-client";
import { buildRazorpayPrefill } from "@/lib/payments/razorpay-prefill";
import { buildCheckoutOptions } from "@/lib/payments/client/checkout-options";
import { FUNDING_SOURCE_LABEL } from "@/lib/labels/org-labels";
import { formatCurrencyAmount } from "@/utils/formatting";

import {
  INVOICE_STATUS,
  daysLate,
  fetchInvoices,
  payInvoice,
  pollInvoiceUntilPaid,
  type BillingSummary,
  type InvoicePayResponse,
  type OrgInvoice,
} from "./billing-api";
import { InvoiceDetailSheet } from "./InvoiceDetailSheet";

// Discriminated union for the post-checkout flow:
//   - "confirmed": webhook landed within the poll budget; row is PAID.
//   - "pending":   capture succeeded but the webhook is slow.
//   - "not_paid":  popup dismissed or `payment.failed` fired (already toasted).
type InvoicePayMutationResult = {
  result: InvoicePayResponse;
  outcome: "confirmed" | "pending" | "not_paid";
};

const invoiceColumns: ResponsiveColumn<OrgInvoice>[] = [
  {
    key: "number",
    header: "Number",
    primary: true,
    className: "font-mono text-xs",
    cell: (inv) => inv.invoiceNumber,
  },
  {
    key: "amount",
    header: "Amount",
    className: "tabular-nums",
    cell: (inv) => formatCurrencyAmount(inv.totalPaise, inv.displayCurrency),
  },
  {
    key: "status",
    header: "Status",
    cell: (inv) => {
      const status = INVOICE_STATUS[inv.status];
      // FDE: quantify the lateness so an overdue invoice isn't an undated alarm.
      const label =
        inv.status === "OVERDUE"
          ? `${status.label} · ${daysLate(inv.dueDate, inv.createdAt)} days late`
          : status.label;
      return <StatusBadge label={label} tone={status.tone} />;
    },
  },
  {
    key: "due",
    header: "Due",
    className: "text-xs text-muted-foreground",
    cell: (inv) =>
      inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : "—",
  },
];

function SummaryStats({ summary }: Readonly<{ summary: BillingSummary }>) {
  const fundingSource = summary.fundingSource;
  return (
    <StatRow columns={4}>
      <Stat
        label="This month gross"
        value={formatCurrencyAmount(summary.monthToDate.gross, "INR")}
        hint={`${summary.monthToDate.paymentCount} bookings`}
      />
      <Stat
        label="Outstanding"
        value={formatCurrencyAmount(summary.outstanding.amount, "INR")}
        hint={`${summary.outstanding.invoiceCount} invoices`}
        tone={summary.outstanding.invoiceCount > 0 ? "warning" : "neutral"}
      />
      {summary.pendingCharges && (
        <Stat
          label="Pending charges"
          value={formatCurrencyAmount(summary.pendingCharges.amount, "INR")}
          hint={`${summary.pendingCharges.paymentCount} not yet invoiced`}
        />
      )}
      {/* #1762-8 — payment terms exist only on invoice-funded accounts. */}
      {fundingSource === "INVOICE" && (
        <Stat
          label="Payment terms"
          value={`${summary.paymentTermsDays} days`}
        />
      )}
      {fundingSource && (
        <Stat
          label="Funding source"
          value={FUNDING_SOURCE_LABEL[fundingSource]}
        />
      )}
    </StatRow>
  );
}

function CreditLimitLine({ summary }: Readonly<{ summary: BillingSummary }>) {
  if (summary.fundingSource !== "INVOICE") return null;
  const outstanding = formatCurrencyAmount(summary.outstanding.amount, "INR");
  // #777 §B: null/absent = unlimited; say so rather than invent a cap.
  if (
    summary.creditLimitPaise === null ||
    summary.creditLimitPaise === undefined
  ) {
    return (
      <p className="text-sm text-muted-foreground">
        {outstanding} outstanding · no credit limit set
      </p>
    );
  }
  const reached = summary.outstanding.amount >= summary.creditLimitPaise;
  return (
    <p className="text-sm text-muted-foreground">
      {outstanding} of {formatCurrencyAmount(summary.creditLimitPaise, "INR")}{" "}
      credit limit used
      {reached && (
        <span className="ml-1 font-medium text-amber-700">— limit reached</span>
      )}
    </p>
  );
}

/**
 * Billing › Invoices: the summary figures, the invoice register with Pay, and
 * the invoice detail sheet (#1836). Creating an invoice is a platform act now
 * (Q8); orgs use "Request an invoice" in the page header.
 */
export function InvoicesPanel({
  orgId,
  summary,
  canPay,
  moneyMoveBlocked,
  moneyMoveReason,
}: Readonly<{
  orgId: string;
  summary: {
    data: BillingSummary | undefined;
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
  };
  canPay: boolean;
  moneyMoveBlocked: boolean;
  moneyMoveReason: string;
}>) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(
    searchParams?.get("invoice") ?? null,
  );

  const invoices = useQuery({
    queryKey: ["org-billing-invoices", orgId],
    queryFn: () => fetchInvoices(orgId),
  });

  const openInvoice = (id: string | null) => {
    setOpenInvoiceId(id);
    // replaceState, like UrlTabs: shareable without a soft navigation.
    const params = new URLSearchParams(window.location.search);
    if (id) params.set("invoice", id);
    else params.delete("invoice");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  };

  const payMutation = useMutation({
    mutationFn: async (
      invoiceId: string,
    ): Promise<InvoicePayMutationResult> => {
      const result = await payInvoice(orgId, invoiceId);
      const loaded = await loadScript(
        "https://checkout.razorpay.com/v1/checkout.js",
      ).catch(() => false);
      if (!loaded || !window.Razorpay) {
        throw new Error(
          "Razorpay checkout failed to load. Please disable ad-blockers and retry.",
        );
      }
      // The popup resolves `true` only if Razorpay's handler fired (capture
      // succeeded); otherwise the row stays ISSUED and we skip polling.
      const prefill = buildRazorpayPrefill({
        name: session?.user?.name ?? null,
        email: session?.user?.email ?? null,
        phone: session?.user?.phone ?? null,
      });
      const paid = await new Promise<boolean>((resolve) => {
        const rzp = new window.Razorpay(
          buildCheckoutOptions({
            keyId: result.keyId,
            amount: result.amountPaise,
            currency: result.currency,
            name: "Familiarise",
            description: `Invoice ${result.invoice.invoiceNumber}`,
            orderId: result.razorpayOrderId,
            prefill: Object.keys(prefill).length > 0 ? prefill : undefined,
            handler: () => resolve(true),
            theme: { color: "#2563EB" },
          }),
        );
        rzp.on("payment.failed", () => {
          toast({
            title: "Payment failed",
            description:
              "Your card was declined or the payment timed out. Please try again.",
            variant: "destructive",
          });
          resolve(false);
        });
        rzp.open();
      });
      if (!paid) return { result, outcome: "not_paid" };
      // Bridge the webhook race; the capture is safe either way (the webhook
      // is idempotent on OrganizationInvoice.providerOrderId).
      const confirmed = await pollInvoiceUntilPaid(orgId, invoiceId);
      return { result, outcome: confirmed ? "confirmed" : "pending" };
    },
    onSuccess: ({ result, outcome }) => {
      void queryClient.invalidateQueries({
        queryKey: ["org-billing-invoices", orgId],
      });
      void queryClient.invalidateQueries({ queryKey: ["org-billing", orgId] });
      if (outcome === "confirmed") {
        toast({
          title: "Invoice paid",
          description: `Invoice ${result.invoice.invoiceNumber} is now paid.`,
        });
      } else if (outcome === "pending") {
        toast({
          title: "Payment received",
          description:
            "Awaiting confirmation from Razorpay. The invoice shows as paid once it lands.",
        });
      }
    },
    onError: (err) => {
      toast({
        title: "Payment could not be initiated",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  // Pay is billing.manage (OWNER + BILLING_ADMIN) on the API.
  const renderInvoiceActions = (inv: OrgInvoice) =>
    (inv.status === "ISSUED" || inv.status === "OVERDUE") && canPay ? (
      <Button
        size="sm"
        variant={inv.status === "OVERDUE" ? "default" : "outline"}
        onClick={(e) => {
          e.stopPropagation();
          payMutation.mutate(inv.id);
        }}
        // #779 §B: the server rejects anyway; this kills the dead click.
        disabled={payMutation.isPending || moneyMoveBlocked}
        title={moneyMoveBlocked ? moneyMoveReason : undefined}
      >
        Pay now
      </Button>
    ) : null;

  let summaryBlock: React.ReactNode;
  if (summary.isPending) {
    summaryBlock = (
      <StatRow columns={4}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  } else if (summary.isError || !summary.data) {
    // A failed fetch is not a zero balance.
    summaryBlock = (
      <ErrorState
        title="Couldn't load the billing summary"
        description="These figures are unavailable right now. This is a loading problem, not a zero balance."
        onRetry={() => void summary.refetch()}
      />
    );
  } else {
    summaryBlock = (
      <>
        <SummaryStats summary={summary.data} />
        <CreditLimitLine summary={summary.data} />
      </>
    );
  }

  const licenseFunded = summary.data?.fundingSource === "LICENSE";

  return (
    <>
      {summaryBlock}
      <Section
        title="Invoices"
        description="Invoices issued to this organization. Open one for its lines, PDF and credit notes."
      >
        <ResponsiveTable<OrgInvoice>
          columns={invoiceColumns}
          rows={invoices.data?.invoices ?? []}
          getRowId={(inv) => inv.id}
          onRowClick={(inv) => openInvoice(inv.id)}
          rowActions={renderInvoiceActions}
          isLoading={invoices.isLoading && !invoices.data}
          error={invoices.isError ? "Couldn't load invoices." : undefined}
          onRetry={() => void invoices.refetch()}
          empty={
            licenseFunded
              ? "License-funded organizations aren't invoiced per booking. The license fee covers usage; see the License tab."
              : "No invoices yet."
          }
        />
      </Section>
      <InvoiceDetailSheet
        orgId={orgId}
        invoiceId={openInvoiceId}
        onClose={() => openInvoice(null)}
      />
    </>
  );
}
