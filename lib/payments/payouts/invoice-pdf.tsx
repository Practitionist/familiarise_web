/**
 * Invoice PDF Generator
 * Generates GST-compliant PDF invoices using @react-pdf/renderer
 * Server-side only — used by the /api/invoices/[id]/pdf route
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
import { TAX_CONSTANTS } from "./constants";
import type { InvoiceItem } from "./invoice-service";

// ============================================
// Types
// ============================================

export interface InvoicePdfData {
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate?: Date;
  paidAt?: Date;
  status: string;

  // Company (seller)
  companyName: string;
  companyAddress: string;
  companyGstin?: string;

  // Customer (buyer)
  customerName: string;
  customerEmail: string;
  customerAddress?: string;
  customerGstin?: string;

  // Line items
  items: InvoiceItem[];

  // Amounts (in paise)
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  discountAmount?: number;
  creditsApplied?: number;
  total: number;
  currency: string;
  isInternational: boolean;

  // Service info
  hsnCode: string;
  paymentMethod?: string;
  transactionId?: string;
  notes?: string;
}

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
    // Indian numbering: lakh (100,000), crore (10,000,000)
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
  // Header
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
  // Status badge
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
  // Info sections
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
  // Table
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
  // Totals
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
  // Amount in words
  amountInWords: {
    fontSize: 9,
    fontStyle: "italic",
    color: "#666",
    marginBottom: 20,
    textAlign: "right",
  },
  // Notes and footer
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
  const halfGstRate = data.taxRate / 2;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.companyName}>{data.companyName}</Text>
            <Text style={styles.companyDetails}>{data.companyAddress}</Text>
            {data.companyGstin && (
              <Text style={styles.companyDetails}>
                GSTIN: {data.companyGstin}
              </Text>
            )}
          </View>
          <View>
            <Text style={styles.invoiceTitle}>
              {data.isInternational ? "EXPORT INVOICE" : "TAX INVOICE"}
            </Text>
            <Text style={styles.invoiceNumber}>{data.invoiceNumber}</Text>
            <View
              style={[
                styles.statusBadge,
                data.status === "SUCCEEDED"
                  ? styles.statusPaid
                  : styles.statusPending,
              ]}
            >
              <Text>
                {data.status === "SUCCEEDED" ? "PAID" : data.status}
              </Text>
            </View>
          </View>
        </View>

        {/* Invoice & Customer Info */}
        <View style={styles.infoRow}>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Bill To</Text>
            <Text style={styles.infoValue}>{data.customerName}</Text>
            <Text style={styles.infoValue}>{data.customerEmail}</Text>
            {data.customerAddress && (
              <Text style={styles.infoValue}>{data.customerAddress}</Text>
            )}
            {data.customerGstin && (
              <Text style={styles.infoValue}>
                GSTIN: {data.customerGstin}
              </Text>
            )}
          </View>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Invoice Details</Text>
            <Text style={styles.infoValue}>
              Date: {formatDate(data.invoiceDate)}
            </Text>
            {data.dueDate && (
              <Text style={styles.infoValue}>
                Due: {formatDate(data.dueDate)}
              </Text>
            )}
            {data.paidAt && (
              <Text style={styles.infoValue}>
                Paid: {formatDate(data.paidAt)}
              </Text>
            )}
            {data.transactionId && (
              <Text style={styles.infoValue}>
                Txn: {data.transactionId}
              </Text>
            )}
            {data.paymentMethod && (
              <Text style={styles.infoValue}>
                Method: {data.paymentMethod}
              </Text>
            )}
          </View>
        </View>

        {/* Items Table */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={styles.colDescription}>Description</Text>
            <Text style={styles.colHsn}>HSN/SAC</Text>
            <Text style={styles.colQty}>Qty</Text>
            <Text style={styles.colRate}>Unit Price</Text>
            <Text style={styles.colAmount}>Amount</Text>
          </View>
          {data.items.map((item, index) => (
            <View style={styles.tableRow} key={index}>
              <Text style={styles.colDescription}>{item.description}</Text>
              <Text style={styles.colHsn}>
                {item.hsnCode || data.hsnCode}
              </Text>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colRate}>
                {formatAmount(item.unitPrice, data.currency)}
              </Text>
              <Text style={styles.colAmount}>
                {formatAmount(item.amount, data.currency)}
              </Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totalsContainer}>
          <View style={styles.totalsBlock}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>
                {formatAmount(data.subtotal, data.currency)}
              </Text>
            </View>

            {data.isInternational ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>GST (Zero-rated export)</Text>
                <Text style={styles.totalValue}>
                  {formatAmount(0, data.currency)}
                </Text>
              </View>
            ) : data.taxAmount > 0 ? (
              <>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>
                    CGST ({halfGstRate}%)
                  </Text>
                  <Text style={styles.totalValue}>
                    {formatAmount(
                      Math.floor(data.taxAmount / 2),
                      data.currency,
                    )}
                  </Text>
                </View>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>
                    SGST ({halfGstRate}%)
                  </Text>
                  <Text style={styles.totalValue}>
                    {formatAmount(
                      Math.ceil(data.taxAmount / 2),
                      data.currency,
                    )}
                  </Text>
                </View>
              </>
            ) : null}

            {data.discountAmount && data.discountAmount > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Discount</Text>
                <Text style={styles.totalValue}>
                  -{formatAmount(data.discountAmount, data.currency)}
                </Text>
              </View>
            ) : null}

            {data.creditsApplied && data.creditsApplied > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Referral Credits</Text>
                <Text style={styles.totalValue}>
                  -{formatAmount(data.creditsApplied, data.currency)}
                </Text>
              </View>
            ) : null}

            <View style={styles.grandTotalRow}>
              <Text style={styles.grandTotalLabel}>Total</Text>
              <Text style={styles.grandTotalValue}>
                {formatAmount(data.total, data.currency)}
              </Text>
            </View>
          </View>
        </View>

        {/* Amount in Words */}
        {data.currency === "INR" && (
          <Text style={styles.amountInWords}>
            {amountInWords(data.total)}
          </Text>
        )}

        {/* Notes */}
        {data.notes && (
          <View style={styles.notesSection}>
            <Text style={styles.notesTitle}>Notes</Text>
            <Text style={styles.notesText}>{data.notes}</Text>
          </View>
        )}

        {data.isInternational && (
          <View style={styles.notesSection}>
            <Text style={styles.notesTitle}>Export Declaration</Text>
            <Text style={styles.notesText}>
              Export of services — Zero-rated supply under Section 16 of IGST
              Act, 2017 read with Section 2(6) of IGST Act. Supply meant for
              export on payment of IGST.
            </Text>
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer}>
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

// ============================================
// PDF Generation
// ============================================

/**
 * Generate a PDF buffer for an invoice
 * Uses @react-pdf/renderer's server-side renderToBuffer
 */
export async function generateInvoicePdf(
  data: InvoicePdfData,
): Promise<Buffer> {
  const buffer = await renderToBuffer(
    <InvoiceDocument data={data} /> as React.ReactElement,
  );
  return Buffer.from(buffer);
}

/**
 * Build InvoicePdfData from a database invoice record
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

  // Calculate credits/discount from difference between original and final
  const creditsOrDiscount =
    payment && payment.originalAmount > 0
      ? payment.originalAmount + taxAmount - invoice.amount
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
    creditsApplied: creditsOrDiscount > 0 ? creditsOrDiscount : undefined,
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
