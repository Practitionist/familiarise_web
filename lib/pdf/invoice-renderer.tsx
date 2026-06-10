/**
 * Invoice PDF renderer — B2B (`OrganizationInvoice`) PDFs.
 *
 * `OrgInvoiceDocument` renders `OrganizationInvoice` rows where the
 * tax engine has already split CGST/SGST/IGST into paise columns;
 * it surfaces the IRN block, reverse-charge marker, and billing-cycle
 * window. Wired from
 * `app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route.ts`.
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
import type { OrgInvoiceStatus, Currency, IrpStatus } from "@prisma/client";

// ============================================================================
// Shared formatting helpers
// ============================================================================

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

function formatDateLong(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// Suppress unused-import warning for React — it is needed for JSX
// type inference in this file even when no React APIs are referenced
// directly.
void React;

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
