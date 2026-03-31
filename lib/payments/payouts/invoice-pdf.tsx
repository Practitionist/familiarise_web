/**
 * Invoice PDF Generator
 * Generates GST-compliant PDF invoices using @react-pdf/renderer
 * Server-side only — used by the /api/invoices/[id]/pdf route
 *
 * REACT COMPATIBILITY NOTE
 * ─────────────────────────────────────────────────────────────────────────
 * In Next.js 15 App Router, `import React from "react"` inside route-handler
 * modules resolves to Next.js's vendored RSC React 19 canary
 * (next/dist/.../rsc/react.js). That canary's createElement stamps elements
 * with Symbol("react.transitional.element"), but react-pdf's reconciler-23
 * (used when React.version is "18.x") only accepts Symbol("react.element").
 *
 * Fix: use __non_webpack_require__("react") for element creation.
 * Next.js defines __non_webpack_require__ as the native Node.js require in
 * its webpack config, so it bypasses the RSC module alias and loads the
 * actual React 18.3.1 from node_modules — whose createElement produces
 * Symbol("react.element") that reconciler-23 accepts.
 *
 * We keep `import React from "react"` for TypeScript type information only.
 * All JSX is written as createElement calls (no JSX syntax) to avoid the
 * RSC jsx-dev-runtime transform which would also create transitional elements.
 */

// TypeScript types only — the actual runtime React is loaded below.
import React from "react";

// Load React 18.3.1 from node_modules via native require, bypassing the RSC
// webpack alias that would otherwise give us the Next.js vendored canary.
declare const __non_webpack_require__: typeof require;
const pdfReact = __non_webpack_require__("react") as typeof React;
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import { z } from "zod";
import { TAX_CONSTANTS } from "./constants";

// ============================================
// Zod Schemas & Types
// ============================================

const InvoiceItemSchema = z.object({
  description: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().int().nonnegative(),
  amount: z.number().int().nonnegative(),
  hsnCode: z.string().optional(),
});

const InvoicePdfDataSchema = z.object({
  invoiceNumber: z.string(),
  invoiceDate: z.date(),
  dueDate: z.date().optional(),
  paidAt: z.date().optional(),
  status: z.string(),

  // Company (seller)
  companyName: z.string(),
  companyAddress: z.string(),
  companyGstin: z.string().optional(),

  // Customer (buyer)
  customerName: z.string(),
  customerEmail: z.string().email(),
  customerAddress: z.string().optional(),
  customerGstin: z.string().optional(),

  // Line items
  items: z.array(InvoiceItemSchema).min(1),

  // Amounts (in paise)
  subtotal: z.number().int().nonnegative(),
  taxRate: z.number().nonnegative(),
  taxAmount: z.number().int().nonnegative(),
  discountAmount: z.number().int().nonnegative().optional(),
  creditsApplied: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative(),
  currency: z.string().length(3),
  isInternational: z.boolean(),

  // Service info
  hsnCode: z.string(),
  paymentMethod: z.string().optional(),
  transactionId: z.string().optional(),
  notes: z.string().optional(),
});

export type InvoicePdfData = z.infer<typeof InvoicePdfDataSchema>;
type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

// ============================================
// Helpers
// ============================================

/** Convert paise to rupees formatted string */
function formatAmount(paise: number, currency: string = "INR"): string {
  const symbols: Record<string, string> = {
    INR: "\u20B9",
    USD: "$",
    EUR: "\u20AC",
    GBP: "\u00A3",
  };
  const symbol = symbols[currency] || currency + " ";
  const amount = (paise / 100).toFixed(2);
  return `${symbol}${amount}`;
}

/** Format date to DD/MM/YYYY */
function formatDate(date: Date): string {
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Convert number to words (Indian numbering) */
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

// ============================================
// Styles
// ============================================

const styles = StyleSheet.create({
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
  statusPaid: {
    backgroundColor: "#dcfce7",
    color: "#166534",
  },
  statusPending: {
    backgroundColor: "#fef3c7",
    color: "#92400e",
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 25,
  },
  infoBlock: {
    width: "48%",
  },
  infoLabel: {
    fontSize: 8,
    color: "#666",
    textTransform: "uppercase",
    marginBottom: 4,
    fontFamily: "Helvetica-Bold",
  },
  infoValue: {
    fontSize: 10,
    lineHeight: 1.5,
  },
  table: {
    marginBottom: 20,
  },
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
  totalsBlock: {
    width: "45%",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  totalLabel: {
    fontSize: 10,
    color: "#666",
  },
  totalValue: {
    fontSize: 10,
    textAlign: "right",
  },
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
  notesTitle: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  notesText: {
    fontSize: 8,
    color: "#666",
    lineHeight: 1.5,
  },
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

// ============================================
// PDF Document Component
// ============================================

function InvoiceDocument({ data }: { data: InvoicePdfData }) {
  const ce = pdfReact.createElement;
  const halfGstRate = data.taxRate / 2;

  // Tax rows: zero-rated export OR CGST+SGST split OR nothing
  const taxRows = data.isInternational
    ? ce(
        View,
        { style: styles.totalRow },
        ce(Text, { style: styles.totalLabel }, "GST (Zero-rated export)"),
        ce(Text, { style: styles.totalValue }, formatAmount(0, data.currency)),
      )
    : data.taxAmount > 0
      ? [
          ce(
            View,
            { style: styles.totalRow, key: "cgst" },
            ce(Text, { style: styles.totalLabel }, `CGST (${halfGstRate}%)`),
            ce(
              Text,
              { style: styles.totalValue },
              formatAmount(Math.floor(data.taxAmount / 2), data.currency),
            ),
          ),
          ce(
            View,
            { style: styles.totalRow, key: "sgst" },
            ce(Text, { style: styles.totalLabel }, `SGST (${halfGstRate}%)`),
            ce(
              Text,
              { style: styles.totalValue },
              formatAmount(Math.ceil(data.taxAmount / 2), data.currency),
            ),
          ),
        ]
      : null;

  return ce(
    Document,
    null,
    ce(
      Page,
      { size: "A4", style: styles.page },

      // ── Header ──────────────────────────────────────────────────────────
      ce(
        View,
        { style: styles.header },
        // Left: company info
        ce(
          View,
          null,
          ce(Text, { style: styles.companyName }, data.companyName),
          ce(Text, { style: styles.companyDetails }, data.companyAddress),
          data.companyGstin
            ? ce(
                Text,
                { style: styles.companyDetails },
                `GSTIN: ${data.companyGstin}`,
              )
            : null,
        ),
        // Right: invoice title + number + status badge
        ce(
          View,
          null,
          ce(
            Text,
            { style: styles.invoiceTitle },
            data.isInternational ? "EXPORT INVOICE" : "TAX INVOICE",
          ),
          ce(Text, { style: styles.invoiceNumber }, data.invoiceNumber),
          ce(
            View,
            {
              style: [
                styles.statusBadge,
                data.status === "SUCCEEDED"
                  ? styles.statusPaid
                  : styles.statusPending,
              ],
            },
            ce(
              Text,
              null,
              data.status === "SUCCEEDED" ? "PAID" : data.status,
            ),
          ),
        ),
      ),

      // ── Bill To + Invoice Details ────────────────────────────────────────
      ce(
        View,
        { style: styles.infoRow },
        ce(
          View,
          { style: styles.infoBlock },
          ce(Text, { style: styles.infoLabel }, "Bill To"),
          ce(Text, { style: styles.infoValue }, data.customerName),
          ce(Text, { style: styles.infoValue }, data.customerEmail),
          data.customerAddress
            ? ce(Text, { style: styles.infoValue }, data.customerAddress)
            : null,
          data.customerGstin
            ? ce(
                Text,
                { style: styles.infoValue },
                `GSTIN: ${data.customerGstin}`,
              )
            : null,
        ),
        ce(
          View,
          { style: styles.infoBlock },
          ce(Text, { style: styles.infoLabel }, "Invoice Details"),
          ce(
            Text,
            { style: styles.infoValue },
            `Date: ${formatDate(data.invoiceDate)}`,
          ),
          data.dueDate
            ? ce(
                Text,
                { style: styles.infoValue },
                `Due: ${formatDate(data.dueDate)}`,
              )
            : null,
          data.paidAt
            ? ce(
                Text,
                { style: styles.infoValue },
                `Paid: ${formatDate(data.paidAt)}`,
              )
            : null,
          data.transactionId
            ? ce(
                Text,
                { style: styles.infoValue },
                `Txn: ${data.transactionId}`,
              )
            : null,
          data.paymentMethod
            ? ce(
                Text,
                { style: styles.infoValue },
                `Method: ${data.paymentMethod}`,
              )
            : null,
        ),
      ),

      // ── Items Table ──────────────────────────────────────────────────────
      ce(
        View,
        { style: styles.table },
        ce(
          View,
          { style: styles.tableHeader },
          ce(Text, { style: styles.colDescription }, "Description"),
          ce(Text, { style: styles.colHsn }, "HSN/SAC"),
          ce(Text, { style: styles.colQty }, "Qty"),
          ce(Text, { style: styles.colRate }, "Unit Price"),
          ce(Text, { style: styles.colAmount }, "Amount"),
        ),
        data.items.map((item: InvoiceItem, index: number) =>
          ce(
            View,
            { style: styles.tableRow, key: index },
            ce(Text, { style: styles.colDescription }, item.description),
            ce(
              Text,
              { style: styles.colHsn },
              item.hsnCode ?? data.hsnCode,
            ),
            ce(Text, { style: styles.colQty }, String(item.quantity)),
            ce(
              Text,
              { style: styles.colRate },
              formatAmount(item.unitPrice, data.currency),
            ),
            ce(
              Text,
              { style: styles.colAmount },
              formatAmount(item.amount, data.currency),
            ),
          ),
        ),
      ),

      // ── Totals ───────────────────────────────────────────────────────────
      ce(
        View,
        { style: styles.totalsContainer },
        ce(
          View,
          { style: styles.totalsBlock },
          ce(
            View,
            { style: styles.totalRow },
            ce(Text, { style: styles.totalLabel }, "Subtotal"),
            ce(
              Text,
              { style: styles.totalValue },
              formatAmount(data.subtotal, data.currency),
            ),
          ),
          taxRows,
          data.discountAmount && data.discountAmount > 0
            ? ce(
                View,
                { style: styles.totalRow },
                ce(Text, { style: styles.totalLabel }, "Discount"),
                ce(
                  Text,
                  { style: styles.totalValue },
                  `-${formatAmount(data.discountAmount, data.currency)}`,
                ),
              )
            : null,
          data.creditsApplied && data.creditsApplied > 0
            ? ce(
                View,
                { style: styles.totalRow },
                ce(Text, { style: styles.totalLabel }, "Referral Credits"),
                ce(
                  Text,
                  { style: styles.totalValue },
                  `-${formatAmount(data.creditsApplied, data.currency)}`,
                ),
              )
            : null,
          ce(
            View,
            { style: styles.grandTotalRow },
            ce(Text, { style: styles.grandTotalLabel }, "Total"),
            ce(
              Text,
              { style: styles.grandTotalValue },
              formatAmount(data.total, data.currency),
            ),
          ),
        ),
      ),

      // ── Amount in Words ──────────────────────────────────────────────────
      data.currency === "INR"
        ? ce(
            Text,
            { style: styles.amountInWords },
            amountInWords(data.total),
          )
        : null,

      // ── Notes ────────────────────────────────────────────────────────────
      data.notes
        ? ce(
            View,
            { style: styles.notesSection },
            ce(Text, { style: styles.notesTitle }, "Notes"),
            ce(Text, { style: styles.notesText }, data.notes),
          )
        : null,

      // ── Export declaration ───────────────────────────────────────────────
      data.isInternational
        ? ce(
            View,
            { style: styles.notesSection },
            ce(Text, { style: styles.notesTitle }, "Export Declaration"),
            ce(
              Text,
              { style: styles.notesText },
              "Export of services \u2014 Zero-rated supply under Section 16 of IGST Act, 2017 read with Section 2(6) of IGST Act. Supply meant for export on payment of IGST.",
            ),
          )
        : null,

      // ── Footer ───────────────────────────────────────────────────────────
      ce(
        View,
        { style: styles.footer },
        ce(
          Text,
          null,
          "This is a computer-generated invoice and does not require a signature.",
        ),
        ce(
          Text,
          { style: { marginTop: 2 } },
          "Familiarise \u2014 Expert Services Marketplace | familiarise.com",
        ),
      ),
    ),
  );
}

// ============================================
// PDF Generation
// ============================================

/**
 * Generate a PDF buffer for an invoice.
 * Validates data with Zod before rendering.
 */
export async function generateInvoicePdf(
  data: InvoicePdfData,
): Promise<Buffer> {
  const validated = InvoicePdfDataSchema.parse(data);
  const buffer = await renderToBuffer(
    pdfReact.createElement(InvoiceDocument, {
      data: validated,
    }) as React.ReactElement,
  );
  return Buffer.from(buffer);
}

/**
 * Build InvoicePdfData from a database invoice record.
 */
export async function getInvoicePdfData(
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
): Promise<InvoicePdfData> {
  const items = (invoice.items as InvoiceItem[]) || [];
  const payment = invoice.payment;

  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const taxAmount = invoice.taxAmount ?? 0;
  const isInternational = payment?.isInternational ?? false;

  // FIX #604: Use originalAmount (immutable) instead of amount (mutable,
  // decremented on partial refund). Prevents invoice discount drift on regeneration.
  const creditsAppliedAmount =
    payment?.creditUsages?.reduce((sum, cu) => sum + (cu.originalAmount ?? cu.amount), 0) ?? 0;

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
    taxRate: invoice.taxRate ?? (isInternational ? 0 : TAX_CONSTANTS.GST_RATE),
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
      ? "Export of services \u2014 Zero-rated under IGST Act Section 2(6)"
      : undefined,
  };
}
