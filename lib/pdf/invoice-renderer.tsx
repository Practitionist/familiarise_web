/**
 * Invoice PDF renderer — single source of truth for both consumer
 * (Payment-based `Invoice`) and B2B (`OrganizationInvoice`) PDFs.
 *
 * Two `<Document>` components live here:
 *   - `ConsumerInvoiceDocument` — consumer invoices with single-rate
 *     GST (CGST+SGST split derived from `taxRate`), referral credits,
 *     discounts, and an export-zero-rated notes block. Wired from
 *     `app/api/invoices/[id]/pdf/route.ts`.
 *   - `OrgInvoiceDocument` — B2B `OrganizationInvoice` rows where the
 *     tax engine has already split CGST/SGST/IGST into paise columns;
 *     surfaces the IRN block, reverse-charge marker, and billing-cycle
 *     window. Wired from
 *     `app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route.ts`.
 *
 * REACT VERSION
 * ─────────────────────────────────────────────────────────────────────────
 * Project React: 18.3.1 (single version in node_modules).
 * `@react-pdf/renderer@4.5.1` → `@react-pdf/reconciler@2.0.0` ships three
 * reconcilers (reconciler-23 for React ≤18, reconciler-31 for React 19.0/19.1,
 * reconciler-33 for React 19.2+) and dispatches by `React.version`. So the
 * renderer works whether the route-handler bundle resolves `react` to our
 * userland 18.3.1 or Next.js's vendored RSC build — a previous workaround
 * that bypassed webpack via `__non_webpack_require__("react")` was
 * load-bearing only against an older react-pdf with the single 23-reconciler
 * and is no longer needed. Plain JSX is sufficient.
 */

import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import { z } from "zod";
import type { OrgInvoiceStatus, Currency, IrpStatus } from "@prisma/client";
import { TAX_CONSTANTS } from "@/lib/payments/payouts/constants";

// ============================================================================
// Shared formatting helpers
// ============================================================================

/** Currency-symbol formatter used by the consumer document. */
function formatAmountWithSymbol(paise: number, currency: string = "INR"): string {
  const symbols: Record<string, string> = {
    INR: "₹",
    USD: "$",
    EUR: "€",
    GBP: "£",
  };
  const symbol = symbols[currency] || currency + " ";
  const amount = (paise / 100).toFixed(2);
  return `${symbol}${amount}`;
}

/** Locale-aware Intl formatter used by the org document. Picks an
 * en-IN / en-US / en-GB locale by currency to keep digit grouping
 * idiomatic for the receiving finance team. */
function formatMoneyIntl(paise: number, currency: Currency): string {
  const major = paise / 100;
  const locale =
    currency === "INR"
      ? "en-IN"
      : currency === "USD"
        ? "en-US"
        : currency === "GBP"
          ? "en-GB"
          : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(major);
}

function formatDateDDMMYYYY(date: Date): string {
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function formatDateLong(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Indian-numbering "amount in words" used on consumer INR invoices. */
function amountInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const paiseRemainder = paise % 100;

  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  function convertToWords(n: number): string {
    if (n === 0) return "";
    if (n < 20) return ones[n];
    if (n < 100)
      return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    if (n < 1000)
      return (
        ones[Math.floor(n / 100)] +
        " Hundred" +
        (n % 100 ? " and " + convertToWords(n % 100) : "")
      );
    if (n < 100000)
      return (
        convertToWords(Math.floor(n / 1000)) +
        " Thousand" +
        (n % 1000 ? " " + convertToWords(n % 1000) : "")
      );
    if (n < 10000000)
      return (
        convertToWords(Math.floor(n / 100000)) +
        " Lakh" +
        (n % 100000 ? " " + convertToWords(n % 100000) : "")
      );
    return (
      convertToWords(Math.floor(n / 10000000)) +
      " Crore" +
      (n % 10000000 ? " " + convertToWords(n % 10000000) : "")
    );
  }

  let result = "Rupees " + (rupees === 0 ? "Zero" : convertToWords(rupees));
  if (paiseRemainder > 0) {
    result += " and " + convertToWords(paiseRemainder) + " Paise";
  }
  result += " Only";
  return result;
}

// Suppress unused-import warning for React — it is needed for JSX
// type inference in this file even when no React APIs are referenced
// directly.
void React;

// ============================================================================
// Consumer (Payment-based) — types, styles, document
// ============================================================================

const consumerItemSchema = z.object({
  description: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().int().nonnegative(),
  amount: z.number().int().nonnegative(),
  hsnCode: z.string().optional(),
});

const consumerInvoiceSchema = z.object({
  invoiceNumber: z.string(),
  invoiceDate: z.date(),
  dueDate: z.date().optional(),
  paidAt: z.date().optional(),
  status: z.string(),

  companyName: z.string(),
  companyAddress: z.string(),
  companyGstin: z.string().optional(),

  customerName: z.string(),
  customerEmail: z.string().email(),
  customerAddress: z.string().optional(),
  customerGstin: z.string().optional(),

  items: z.array(consumerItemSchema).min(1),

  subtotal: z.number().int().nonnegative(),
  taxRate: z.number().nonnegative(),
  taxAmount: z.number().int().nonnegative(),
  discountAmount: z.number().int().nonnegative().optional(),
  creditsApplied: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative(),
  currency: z.string().length(3),
  isInternational: z.boolean(),

  hsnCode: z.string(),
  paymentMethod: z.string().optional(),
  transactionId: z.string().optional(),
  notes: z.string().optional(),
});

export type ConsumerInvoicePdfData = z.infer<typeof consumerInvoiceSchema>;
type ConsumerInvoiceItem = z.infer<typeof consumerItemSchema>;

const consumerStyles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1a1a1a",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 30,
    borderBottom: "2px solid #2563EB",
    paddingBottom: 15,
  },
  companyName: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: "#2563EB",
  },
  companyDetails: {
    fontSize: 8,
    color: "#666",
    marginTop: 4,
  },
  invoiceTitle: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    textAlign: "right",
    color: "#2563EB",
  },
  invoiceNumber: {
    fontSize: 10,
    textAlign: "right",
    marginTop: 4,
  },
  statusBadge: {
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    alignSelf: "flex-end",
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
  },
  statusPaid: { backgroundColor: "#dcfce7", color: "#166534" },
  statusPending: { backgroundColor: "#fef3c7", color: "#92400e" },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 25,
  },
  infoBlock: { width: "48%" },
  infoLabel: {
    fontSize: 8,
    color: "#666",
    textTransform: "uppercase",
    marginBottom: 4,
    fontFamily: "Helvetica-Bold",
  },
  infoValue: { fontSize: 10, lineHeight: 1.5 },
  table: { marginBottom: 20 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    padding: 8,
    borderBottom: "1px solid #e2e8f0",
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
  },
  tableRow: {
    flexDirection: "row",
    padding: 8,
    borderBottom: "1px solid #f1f5f9",
  },
  colDescription: { width: "40%" },
  colHsn: { width: "15%", textAlign: "center" },
  colQty: { width: "10%", textAlign: "center" },
  colRate: { width: "17.5%", textAlign: "right" },
  colAmount: { width: "17.5%", textAlign: "right" },
  totalsContainer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: 15,
  },
  totalsBlock: { width: "45%" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  totalLabel: { fontSize: 10, color: "#666" },
  totalValue: { fontSize: 10, textAlign: "right" },
  grandTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: "#2563EB",
    borderRadius: 4,
    marginTop: 4,
  },
  grandTotalLabel: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#ffffff",
  },
  grandTotalValue: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#ffffff",
    textAlign: "right",
  },
  amountInWords: {
    fontSize: 9,
    fontStyle: "italic",
    color: "#666",
    marginBottom: 20,
    textAlign: "right",
  },
  notesSection: {
    marginTop: 10,
    padding: 10,
    backgroundColor: "#f8fafc",
    borderRadius: 4,
  },
  notesTitle: { fontSize: 9, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  notesText: { fontSize: 8, color: "#666", lineHeight: 1.5 },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 40,
    right: 40,
    borderTop: "1px solid #e2e8f0",
    paddingTop: 10,
    fontSize: 8,
    color: "#999",
    textAlign: "center",
  },
});

function ConsumerInvoiceDocument({ data }: { data: ConsumerInvoicePdfData }) {
  const halfGstRate = data.taxRate / 2;
  const showCgstSgst = !data.isInternational && data.taxAmount > 0;

  return (
    <Document>
      <Page size="A4" style={consumerStyles.page}>
        {/* Header */}
        <View style={consumerStyles.header}>
          <View>
            <Text style={consumerStyles.companyName}>{data.companyName}</Text>
            <Text style={consumerStyles.companyDetails}>
              {data.companyAddress}
            </Text>
            {data.companyGstin && (
              <Text style={consumerStyles.companyDetails}>
                GSTIN: {data.companyGstin}
              </Text>
            )}
          </View>
          <View>
            <Text style={consumerStyles.invoiceTitle}>
              {data.isInternational ? "EXPORT INVOICE" : "TAX INVOICE"}
            </Text>
            <Text style={consumerStyles.invoiceNumber}>
              {data.invoiceNumber}
            </Text>
            <View
              style={[
                consumerStyles.statusBadge,
                data.status === "SUCCEEDED"
                  ? consumerStyles.statusPaid
                  : consumerStyles.statusPending,
              ]}
            >
              <Text>
                {data.status === "SUCCEEDED" ? "PAID" : data.status}
              </Text>
            </View>
          </View>
        </View>

        {/* Bill To + Invoice Details */}
        <View style={consumerStyles.infoRow}>
          <View style={consumerStyles.infoBlock}>
            <Text style={consumerStyles.infoLabel}>Bill To</Text>
            <Text style={consumerStyles.infoValue}>{data.customerName}</Text>
            <Text style={consumerStyles.infoValue}>{data.customerEmail}</Text>
            {data.customerAddress && (
              <Text style={consumerStyles.infoValue}>
                {data.customerAddress}
              </Text>
            )}
            {data.customerGstin && (
              <Text style={consumerStyles.infoValue}>
                GSTIN: {data.customerGstin}
              </Text>
            )}
          </View>
          <View style={consumerStyles.infoBlock}>
            <Text style={consumerStyles.infoLabel}>Invoice Details</Text>
            <Text style={consumerStyles.infoValue}>
              Date: {formatDateDDMMYYYY(data.invoiceDate)}
            </Text>
            {data.dueDate && (
              <Text style={consumerStyles.infoValue}>
                Due: {formatDateDDMMYYYY(data.dueDate)}
              </Text>
            )}
            {data.paidAt && (
              <Text style={consumerStyles.infoValue}>
                Paid: {formatDateDDMMYYYY(data.paidAt)}
              </Text>
            )}
            {data.transactionId && (
              <Text style={consumerStyles.infoValue}>
                Txn: {data.transactionId}
              </Text>
            )}
            {data.paymentMethod && (
              <Text style={consumerStyles.infoValue}>
                Method: {data.paymentMethod}
              </Text>
            )}
          </View>
        </View>

        {/* Items */}
        <View style={consumerStyles.table}>
          <View style={consumerStyles.tableHeader}>
            <Text style={consumerStyles.colDescription}>Description</Text>
            <Text style={consumerStyles.colHsn}>HSN/SAC</Text>
            <Text style={consumerStyles.colQty}>Qty</Text>
            <Text style={consumerStyles.colRate}>Unit Price</Text>
            <Text style={consumerStyles.colAmount}>Amount</Text>
          </View>
          {data.items.map((item: ConsumerInvoiceItem, idx: number) => (
            <View key={idx} style={consumerStyles.tableRow}>
              <Text style={consumerStyles.colDescription}>
                {item.description}
              </Text>
              <Text style={consumerStyles.colHsn}>
                {item.hsnCode ?? data.hsnCode}
              </Text>
              <Text style={consumerStyles.colQty}>{item.quantity}</Text>
              <Text style={consumerStyles.colRate}>
                {formatAmountWithSymbol(item.unitPrice, data.currency)}
              </Text>
              <Text style={consumerStyles.colAmount}>
                {formatAmountWithSymbol(item.amount, data.currency)}
              </Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={consumerStyles.totalsContainer}>
          <View style={consumerStyles.totalsBlock}>
            <View style={consumerStyles.totalRow}>
              <Text style={consumerStyles.totalLabel}>Subtotal</Text>
              <Text style={consumerStyles.totalValue}>
                {formatAmountWithSymbol(data.subtotal, data.currency)}
              </Text>
            </View>

            {data.isInternational && (
              <View style={consumerStyles.totalRow}>
                <Text style={consumerStyles.totalLabel}>
                  GST (Zero-rated export)
                </Text>
                <Text style={consumerStyles.totalValue}>
                  {formatAmountWithSymbol(0, data.currency)}
                </Text>
              </View>
            )}
            {showCgstSgst && (
              <>
                <View style={consumerStyles.totalRow}>
                  <Text style={consumerStyles.totalLabel}>
                    CGST ({halfGstRate}%)
                  </Text>
                  <Text style={consumerStyles.totalValue}>
                    {formatAmountWithSymbol(
                      Math.floor(data.taxAmount / 2),
                      data.currency,
                    )}
                  </Text>
                </View>
                <View style={consumerStyles.totalRow}>
                  <Text style={consumerStyles.totalLabel}>
                    SGST ({halfGstRate}%)
                  </Text>
                  <Text style={consumerStyles.totalValue}>
                    {formatAmountWithSymbol(
                      Math.ceil(data.taxAmount / 2),
                      data.currency,
                    )}
                  </Text>
                </View>
              </>
            )}

            {data.discountAmount && data.discountAmount > 0 ? (
              <View style={consumerStyles.totalRow}>
                <Text style={consumerStyles.totalLabel}>Discount</Text>
                <Text style={consumerStyles.totalValue}>
                  -{formatAmountWithSymbol(data.discountAmount, data.currency)}
                </Text>
              </View>
            ) : null}
            {data.creditsApplied && data.creditsApplied > 0 ? (
              <View style={consumerStyles.totalRow}>
                <Text style={consumerStyles.totalLabel}>Referral Credits</Text>
                <Text style={consumerStyles.totalValue}>
                  -
                  {formatAmountWithSymbol(data.creditsApplied, data.currency)}
                </Text>
              </View>
            ) : null}

            <View style={consumerStyles.grandTotalRow}>
              <Text style={consumerStyles.grandTotalLabel}>Total</Text>
              <Text style={consumerStyles.grandTotalValue}>
                {formatAmountWithSymbol(data.total, data.currency)}
              </Text>
            </View>
          </View>
        </View>

        {/* Amount in Words (INR only) */}
        {data.currency === "INR" && (
          <Text style={consumerStyles.amountInWords}>
            {amountInWords(data.total)}
          </Text>
        )}

        {data.notes && (
          <View style={consumerStyles.notesSection}>
            <Text style={consumerStyles.notesTitle}>Notes</Text>
            <Text style={consumerStyles.notesText}>{data.notes}</Text>
          </View>
        )}

        {data.isInternational && (
          <View style={consumerStyles.notesSection}>
            <Text style={consumerStyles.notesTitle}>Export Declaration</Text>
            <Text style={consumerStyles.notesText}>
              Export of services — Zero-rated supply under Section 16 of IGST
              Act, 2017 read with Section 2(6) of IGST Act. Supply meant for
              export on payment of IGST.
            </Text>
          </View>
        )}

        <View style={consumerStyles.footer} fixed>
          <Text>
            This is a computer-generated invoice and does not require a
            signature.
          </Text>
          <Text style={{ marginTop: 2 }}>
            Familiarise — Expert Services Marketplace | familiarise.com
          </Text>
        </View>
      </Page>
    </Document>
  );
}

/** Render a consumer Payment-based invoice to a Buffer. */
export async function generateConsumerInvoicePdf(
  data: ConsumerInvoicePdfData,
): Promise<Buffer> {
  const validated = consumerInvoiceSchema.parse(data);
  const buffer = await renderToBuffer(
    <ConsumerInvoiceDocument data={validated} />,
  );
  return Buffer.from(buffer);
}

/** Build ConsumerInvoicePdfData from a database invoice + payment record. */
export async function getConsumerInvoicePdfData(
  invoice: {
    id: string;
    invoiceNumber: string;
    amount: number;
    currency: string;
    status: string;
    items: unknown;
    taxAmount: number | null;
    taxRate: number | null;
    hsnCode: string | null;
    paidAt: Date | null;
    dueDate: Date | null;
    pdfUrl: string | null;
    createdAt: Date;
    payment: {
      id: string;
      paymentIntent: string | null;
      paymentMethod: string;
      originalAmount: number;
      amount: number;
      isInternational: boolean;
      user: {
        name: string | null;
        email: string;
      };
      discountCode?: {
        code: string;
        discountType: string;
        discountValue: number;
      } | null;
      creditUsages?: { amount: number; originalAmount?: number }[];
    } | null;
  },
  companyInfo?: {
    companyName?: string;
    companyAddress?: string;
    companyGstin?: string;
  },
): Promise<ConsumerInvoicePdfData> {
  const items = (invoice.items as ConsumerInvoiceItem[]) || [];
  const payment = invoice.payment;

  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const taxAmount = invoice.taxAmount ?? 0;
  const isInternational = payment?.isInternational ?? false;

  // Use originalAmount (immutable) over amount (mutable, decremented on
  // partial refund). Prevents invoice discount drift on regeneration. See
  // the discussion in PR #604.
  const creditsAppliedAmount =
    payment?.creditUsages?.reduce(
      (sum, cu) => sum + (cu.originalAmount ?? cu.amount),
      0,
    ) ?? 0;

  const discountAmount =
    payment && payment.originalAmount > 0
      ? Math.max(
          0,
          payment.originalAmount +
            taxAmount -
            creditsAppliedAmount -
            invoice.amount,
        )
      : 0;

  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.createdAt,
    dueDate: invoice.dueDate ?? undefined,
    paidAt: invoice.paidAt ?? undefined,
    status: invoice.status,

    companyName: companyInfo?.companyName ?? "Familiarise",
    companyAddress:
      companyInfo?.companyAddress ?? "Expert Services Marketplace",
    companyGstin: companyInfo?.companyGstin,

    customerName: payment?.user.name ?? "Customer",
    customerEmail: payment?.user.email ?? "",

    items,
    subtotal,
    taxRate:
      invoice.taxRate ?? (isInternational ? 0 : TAX_CONSTANTS.GST_RATE),
    taxAmount,
    discountAmount: discountAmount > 0 ? discountAmount : undefined,
    creditsApplied:
      creditsAppliedAmount > 0 ? creditsAppliedAmount : undefined,
    total: invoice.amount,
    currency: invoice.currency,
    isInternational,

    hsnCode: invoice.hsnCode ?? TAX_CONSTANTS.HSN_CODES.CONSULTING,
    paymentMethod: payment?.paymentMethod,
    transactionId: payment?.paymentIntent ?? undefined,
    notes: isInternational
      ? "Export of services — Zero-rated under IGST Act Section 2(6)"
      : undefined,
  };
}

// ============================================================================
// Org (B2B OrganizationInvoice) — types, styles, document
// ============================================================================

export type OrgInvoiceLineItem = {
  description: string;
  quantity: number;
  unitPrice: number; // in paise
  paymentId?: string | null;
  hsnCode?: string | null;
};

export type OrgInvoicePdfData = {
  invoiceNumber: string;
  status: OrgInvoiceStatus;
  displayCurrency: Currency;
  subtotalPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  hsnCode: string;
  placeOfSupply?: string | null;
  gstin?: string | null;
  reverseCharge: boolean;
  issuedAt?: Date | null;
  dueDate: Date;
  paidAt?: Date | null;
  billingCycleStart?: Date | null;
  billingCycleEnd?: Date | null;
  items: OrgInvoiceLineItem[];
  org: {
    name: string;
    gstin?: string | null;
    billingEmail?: string | null;
    /** Registered address (org-side). Today stored in org metadata; optional. */
    address?: string | null;
  };
  supplier: {
    name: string;
    gstin: string;
    address: string;
    email: string;
  };
  irn?: {
    value?: string | null;
    ackNumber?: string | null;
    ackDate?: Date | null;
    irpStatus: IrpStatus;
  };
};

const orgStyles = StyleSheet.create({
  page: {
    padding: 36,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#222",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottom: "1 solid #222",
    paddingBottom: 12,
    marginBottom: 18,
  },
  headerLeft: { flexDirection: "column" },
  headerRight: { flexDirection: "column", alignItems: "flex-end" },
  title: { fontSize: 16, fontWeight: "bold", marginBottom: 4 },
  invoiceNumber: { fontSize: 10, color: "#666" },
  sectionTitle: {
    fontSize: 10,
    fontWeight: "bold",
    marginTop: 14,
    marginBottom: 6,
    textTransform: "uppercase",
    color: "#666",
  },
  parties: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  party: { width: "48%" },
  partyName: { fontSize: 11, fontWeight: "bold", marginBottom: 2 },
  partyLine: { fontSize: 9, color: "#444", marginBottom: 1 },
  table: { marginTop: 4 },
  tableHeader: {
    flexDirection: "row",
    borderBottom: "1 solid #222",
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottom: "0.5 solid #ddd",
  },
  tcDescription: { width: "46%" },
  tcHsn: { width: "12%", textAlign: "center" },
  tcQty: { width: "8%", textAlign: "right" },
  tcUnit: { width: "16%", textAlign: "right" },
  tcTotal: { width: "18%", textAlign: "right" },
  totalsBox: { alignSelf: "flex-end", width: "55%", marginTop: 14 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  totalLabel: { fontSize: 10, color: "#444" },
  totalValue: { fontSize: 10 },
  grandTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTop: "1 solid #222",
    marginTop: 6,
    paddingTop: 6,
  },
  grandLabel: { fontSize: 11, fontWeight: "bold" },
  grandValue: { fontSize: 12, fontWeight: "bold" },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    borderTop: "0.5 solid #ccc",
    paddingTop: 8,
    fontSize: 8,
    color: "#888",
    textAlign: "center",
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: "bold",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    marginTop: 4,
  },
  irnBlock: {
    marginTop: 16,
    padding: 8,
    border: "0.5 solid #bbb",
    backgroundColor: "#fafafa",
  },
  irnLabel: { fontSize: 8, color: "#666" },
  irnValue: { fontSize: 9, fontFamily: "Courier" },
});

function OrgInvoiceDocument({ data }: { data: OrgInvoicePdfData }) {
  const hasTax =
    data.igstPaise > 0 || data.cgstPaise > 0 || data.sgstPaise > 0;
  const statusColor: Record<OrgInvoiceStatus, string> = {
    DRAFT: "#999",
    ISSUED: "#2563eb",
    PAID: "#16a34a",
    OVERDUE: "#dc2626",
    VOID: "#6b7280",
    CANCELLED: "#6b7280",
    REFUNDED: "#b91c1c",
  };

  return (
    <Document>
      <Page size="A4" style={orgStyles.page}>
        <View style={orgStyles.header}>
          <View style={orgStyles.headerLeft}>
            <Text style={orgStyles.title}>TAX INVOICE</Text>
            <Text style={orgStyles.invoiceNumber}>#{data.invoiceNumber}</Text>
            <Text
              style={{
                ...orgStyles.statusBadge,
                color: statusColor[data.status],
                borderWidth: 0.5,
                borderColor: statusColor[data.status],
              }}
            >
              {data.status}
            </Text>
          </View>
          <View style={orgStyles.headerRight}>
            <Text style={orgStyles.partyName}>{data.supplier.name}</Text>
            <Text style={orgStyles.partyLine}>
              GSTIN: {data.supplier.gstin}
            </Text>
            <Text style={orgStyles.partyLine}>{data.supplier.address}</Text>
            <Text style={orgStyles.partyLine}>{data.supplier.email}</Text>
          </View>
        </View>

        <View style={orgStyles.parties}>
          <View style={orgStyles.party}>
            <Text style={orgStyles.sectionTitle}>Bill to</Text>
            <Text style={orgStyles.partyName}>{data.org.name}</Text>
            {data.org.gstin && (
              <Text style={orgStyles.partyLine}>GSTIN: {data.org.gstin}</Text>
            )}
            {data.org.address && (
              <Text style={orgStyles.partyLine}>{data.org.address}</Text>
            )}
            {data.org.billingEmail && (
              <Text style={orgStyles.partyLine}>{data.org.billingEmail}</Text>
            )}
          </View>
          <View style={orgStyles.party}>
            <Text style={orgStyles.sectionTitle}>Dates</Text>
            <Text style={orgStyles.partyLine}>
              Issued: {formatDateLong(data.issuedAt ?? null)}
            </Text>
            <Text style={orgStyles.partyLine}>
              Due: {formatDateLong(data.dueDate)}
            </Text>
            {data.paidAt && (
              <Text style={orgStyles.partyLine}>
                Paid: {formatDateLong(data.paidAt)}
              </Text>
            )}
            {data.billingCycleStart && data.billingCycleEnd && (
              <Text style={orgStyles.partyLine}>
                Cycle: {formatDateLong(data.billingCycleStart)} —{" "}
                {formatDateLong(data.billingCycleEnd)}
              </Text>
            )}
            {data.placeOfSupply && (
              <Text style={orgStyles.partyLine}>
                Place of supply: {data.placeOfSupply}
              </Text>
            )}
            {data.reverseCharge && (
              <Text style={orgStyles.partyLine}>Reverse charge: YES</Text>
            )}
          </View>
        </View>

        <Text style={orgStyles.sectionTitle}>Line items</Text>
        <View style={orgStyles.table}>
          <View style={orgStyles.tableHeader}>
            <Text style={orgStyles.tcDescription}>Description</Text>
            <Text style={orgStyles.tcHsn}>HSN/SAC</Text>
            <Text style={orgStyles.tcQty}>Qty</Text>
            <Text style={orgStyles.tcUnit}>Unit price</Text>
            <Text style={orgStyles.tcTotal}>Line total</Text>
          </View>
          {data.items.map((item, idx) => (
            <View key={idx} style={orgStyles.tableRow}>
              <Text style={orgStyles.tcDescription}>{item.description}</Text>
              <Text style={orgStyles.tcHsn}>
                {item.hsnCode ?? data.hsnCode}
              </Text>
              <Text style={orgStyles.tcQty}>{item.quantity}</Text>
              <Text style={orgStyles.tcUnit}>
                {formatMoneyIntl(item.unitPrice, data.displayCurrency)}
              </Text>
              <Text style={orgStyles.tcTotal}>
                {formatMoneyIntl(
                  item.quantity * item.unitPrice,
                  data.displayCurrency,
                )}
              </Text>
            </View>
          ))}
        </View>

        <View style={orgStyles.totalsBox}>
          <View style={orgStyles.totalRow}>
            <Text style={orgStyles.totalLabel}>Subtotal</Text>
            <Text style={orgStyles.totalValue}>
              {formatMoneyIntl(data.subtotalPaise, data.displayCurrency)}
            </Text>
          </View>
          {hasTax && data.igstPaise > 0 && (
            <View style={orgStyles.totalRow}>
              <Text style={orgStyles.totalLabel}>IGST</Text>
              <Text style={orgStyles.totalValue}>
                {formatMoneyIntl(data.igstPaise, data.displayCurrency)}
              </Text>
            </View>
          )}
          {hasTax && data.cgstPaise > 0 && (
            <View style={orgStyles.totalRow}>
              <Text style={orgStyles.totalLabel}>CGST</Text>
              <Text style={orgStyles.totalValue}>
                {formatMoneyIntl(data.cgstPaise, data.displayCurrency)}
              </Text>
            </View>
          )}
          {hasTax && data.sgstPaise > 0 && (
            <View style={orgStyles.totalRow}>
              <Text style={orgStyles.totalLabel}>SGST</Text>
              <Text style={orgStyles.totalValue}>
                {formatMoneyIntl(data.sgstPaise, data.displayCurrency)}
              </Text>
            </View>
          )}
          <View style={orgStyles.grandTotal}>
            <Text style={orgStyles.grandLabel}>Total</Text>
            <Text style={orgStyles.grandValue}>
              {formatMoneyIntl(data.totalPaise, data.displayCurrency)}
            </Text>
          </View>
        </View>

        {data.irn?.value && (
          <View style={orgStyles.irnBlock}>
            <Text style={orgStyles.irnLabel}>IRN (e-invoice)</Text>
            <Text style={orgStyles.irnValue}>{data.irn.value}</Text>
            {data.irn.ackNumber && (
              <>
                <Text style={{ ...orgStyles.irnLabel, marginTop: 4 }}>
                  Ack number
                </Text>
                <Text style={orgStyles.irnValue}>{data.irn.ackNumber}</Text>
              </>
            )}
            {data.irn.ackDate && (
              <>
                <Text style={{ ...orgStyles.irnLabel, marginTop: 4 }}>
                  Ack date
                </Text>
                <Text style={orgStyles.irnValue}>
                  {formatDateLong(data.irn.ackDate)}
                </Text>
              </>
            )}
          </View>
        )}

        <View style={orgStyles.footer} fixed>
          <Text>
            System-generated invoice — does not require signature.{" "}
            {data.supplier.name} · {data.supplier.email}
          </Text>
        </View>
      </Page>
    </Document>
  );
}

/** Render an OrganizationInvoice to a Buffer. */
export async function renderOrgInvoicePdf(
  data: OrgInvoicePdfData,
): Promise<Buffer> {
  const buffer = await renderToBuffer(<OrgInvoiceDocument data={data} />);
  return Buffer.from(buffer);
}
