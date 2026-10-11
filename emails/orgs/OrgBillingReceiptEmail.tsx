import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type OrgBillingReceiptKind =
  "INVOICE_ISSUED" | "INVOICE_PAID" | "WALLET_TOPUP_CONFIRMED";

export interface OrgBillingReceiptEmailProps {
  kind: OrgBillingReceiptKind;
  recipientName: string;
  orgName: string;
  amountText: string;
  invoiceNumber?: string | null;
  dueDateText?: string | null;
  newBalanceText?: string | null;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export const OrgBillingReceiptEmail = ({
  kind,
  recipientName,
  orgName,
  amountText,
  invoiceNumber,
  dueDateText,
  newBalanceText,
  dashboardUrl,
  unsubscribeUrl,
}: OrgBillingReceiptEmailProps) => {
  const invLabel = invoiceNumber ? ` ${invoiceNumber}` : "";
  const title =
    kind === "INVOICE_ISSUED"
      ? `Invoice${invLabel} issued for ${orgName}`
      : kind === "INVOICE_PAID"
        ? `Invoice${invLabel} paid for ${orgName}`
        : `Wallet top-up confirmed for ${orgName}`;

  const ctaLabel =
    kind === "INVOICE_ISSUED"
      ? "View & pay invoice"
      : kind === "INVOICE_PAID"
        ? "View receipt"
        : "View wallet balance";

  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl} showSupport>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {kind === "INVOICE_ISSUED" ? (
        <Text style={paragraph}>
          Invoice{invLabel ? <strong>{invLabel}</strong> : null} for{" "}
          <strong>{orgName}</strong> in the amount of{" "}
          <strong>{amountText}</strong> has been issued
          {dueDateText ? (
            <>
              {" "}
              and is due on <strong>{dueDateText}</strong>
            </>
          ) : null}
          .
        </Text>
      ) : kind === "INVOICE_PAID" ? (
        <Text style={paragraph}>
          We received your payment of <strong>{amountText}</strong> for invoice
          {invLabel ? <strong>{invLabel}</strong> : null} on{" "}
          <strong>{orgName}</strong>.
        </Text>
      ) : (
        <Text style={paragraph}>
          Your wallet top-up of <strong>{amountText}</strong> for{" "}
          <strong>{orgName}</strong> has been credited
          {newBalanceText ? (
            <>
              . Updated balance: <strong>{newBalanceText}</strong>
            </>
          ) : null}
          .
        </Text>
      )}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {ctaLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
};

export default OrgBillingReceiptEmail;
