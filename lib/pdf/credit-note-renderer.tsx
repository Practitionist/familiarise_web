/**
 * Credit-note PDF renderer — CGST s.34 `CreditNote` documents (#1230).
 *
 * A refund without a credit note is a GST defect: output tax was reversed
 * internally while the buyer held an invoice that still stands. The minting
 * side (mintRefundCreditNote) has been live since #778 §D; this renders the
 * document so the buyer actually receives it, mirroring
 * invoice-renderer.tsx. Kept self-contained rather than importing shared
 * helpers from the invoice renderer so each PDF surface stays a leaf module.
 *
 * Rule 46 fields for a credit note: "Tax Credit Note" title, supplier and
 * recipient identification, the consecutive number (≤16 chars, Rule 53),
 * date, the ORIGINAL invoice reference required by s.34(1), taxable value,
 * tax split, and rate of tax.
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
import type { Currency } from "@prisma/client";

export type CreditNotePdfData = {
  creditNoteNumber: string;
  issuedAt?: Date | null;
  reason?: string | null;
  displayCurrency: Currency;
  subtotalPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  /** Original invoice linkage — s.34(1)(a) requires the reference. */
  originalInvoiceNumber?: string | null;
  originalInvoiceDate?: Date | null;
  org: {
    name: string;
    gstin?: string | null;
    billingEmail?: string | null;
    address?: string | null;
  };
  supplier: {
    name: string;
    gstin: string;
    address: string;
    email: string;
  };
};

function formatMoney(paise: number, currency: Currency): string {
  return new Intl.NumberFormat(
    currency === "INR" ? "en-IN" : "en-US",
    { style: "currency", currency, minimumFractionDigits: 2 },
  ).format(paise / 100);
}

function fmt(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN");
}

const styles = StyleSheet.create({
  page: { padding: 36, fontFamily: "Helvetica", fontSize: 10, color: "#222" },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottom: "1 solid #222",
    paddingBottom: 12,
    marginBottom: 14,
  },
  title: { fontSize: 15, fontWeight: "bold" },
  subtitle: { fontSize: 9, color: "#555", marginTop: 3 },
  kv: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  k: { color: "#666" },
  v: { fontWeight: "bold" },
  sectionTitle: {
    fontSize: 9,
    fontWeight: "bold",
    color: "#555",
    marginTop: 14,
    marginBottom: 4,
  },
  box: { border: "1 solid #ddd", padding: 10 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f3f3f3",
    padding: 6,
    fontWeight: "bold",
  },
  row: { flexDirection: "row", padding: 6, borderBottom: "0.5 solid #eee" },
  colDesc: { flex: 2 },
  colNum: { flex: 1, textAlign: "right" },
  totalsRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  totalsBox: { width: 220 },
  totalLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 3,
  },
  grandTotal: { fontSize: 11, fontWeight: "bold", marginTop: 4 },
  footer: {
    marginTop: 22,
    fontSize: 8,
    color: "#777",
    borderTop: "0.5 solid #ddd",
    paddingTop: 8,
  },
});

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.k}>{label}</Text>
      <Text style={styles.v}>{value}</Text>
    </View>
  );
}

export function OrgCreditNoteDocument({ data }: { data: CreditNotePdfData }) {
  const taxRate =
    data.subtotalPaise > 0
      ? ((data.igstPaise + data.cgstPaise + data.sgstPaise) /
          data.subtotalPaise) *
        100
      : 0;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Tax Credit Note</Text>
            <Text style={styles.subtitle}>
              Issued under Section 34 of the CGST Act, 2017
              {data.reason ? ` — ${data.reason}` : ""}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ fontWeight: "bold" }}>{data.creditNoteNumber}</Text>
            <Text>Date: {fmt(data.issuedAt)}</Text>
          </View>
        </View>

        <View style={styles.box}>
          <Text style={styles.sectionTitle}>Supplier</Text>
          <Text>{data.supplier.name}</Text>
          <Text>GSTIN: {data.supplier.gstin}</Text>
          <Text>{data.supplier.address}</Text>
          <Text>{data.supplier.email}</Text>
          <Text style={styles.sectionTitle}>Recipient</Text>
          <Text>{data.org.name}</Text>
          {data.org.gstin ? <Text>GSTIN: {data.org.gstin}</Text> : null}
          {data.org.address ? <Text>{data.org.address}</Text> : null}
          {data.org.billingEmail ? <Text>{data.org.billingEmail}</Text> : null}
        </View>

        <Text style={styles.sectionTitle}>
          Original document reference — Sec 34(1)
        </Text>
        <View style={styles.box}>
          <Kv
            label="Invoice number"
            value={data.originalInvoiceNumber ?? "B2C / unregistered supply"}
          />
          <Kv
            label="Invoice date"
            value={
              data.originalInvoiceDate ? fmt(data.originalInvoiceDate) : "—"
            }
          />
        </View>

        <Text style={styles.sectionTitle}>Adjustment</Text>
        <View>
          <View style={styles.tableHeader}>
            <Text style={styles.colDesc}>Description</Text>
            <Text style={styles.colNum}>Amount</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.colDesc}>
              Taxable value reduced ({taxRate.toFixed(0)}% rate)
            </Text>
            <Text style={styles.colNum}>
              {formatMoney(data.subtotalPaise, data.displayCurrency)}
            </Text>
          </View>
          {data.igstPaise > 0 && (
            <View style={styles.row}>
              <Text style={styles.colDesc}>IGST reversed</Text>
              <Text style={styles.colNum}>
                {formatMoney(data.igstPaise, data.displayCurrency)}
              </Text>
            </View>
          )}
          {data.cgstPaise > 0 && (
            <View style={styles.row}>
              <Text style={styles.colDesc}>CGST reversed</Text>
              <Text style={styles.colNum}>
                {formatMoney(data.cgstPaise, data.displayCurrency)}
              </Text>
            </View>
          )}
          {data.sgstPaise > 0 && (
            <View style={styles.row}>
              <Text style={styles.colDesc}>SGST reversed</Text>
              <Text style={styles.colNum}>
                {formatMoney(data.sgstPaise, data.displayCurrency)}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.totalsRow}>
          <View style={styles.totalsBox}>
            <View style={styles.totalLine}>
              <Text>Total credit to recipient</Text>
              <Text style={styles.grandTotal}>
                {formatMoney(data.totalPaise, data.displayCurrency)}
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.footer}>
          System-generated credit note — does not require a signature per
          Notification No. 61/2020-Central Tax. This document reduces the
          supplier&apos;s output tax liability corresponding to the referenced
          invoice; the recipient must reduce input tax credit accordingly.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderOrgCreditNotePdf(
  data: CreditNotePdfData,
): Promise<Buffer> {
  return await renderToBuffer(<OrgCreditNoteDocument data={data} />);
}
