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
  settledText?: string | null;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

function billingTitle(
  kind: OrgBillingReceiptKind,
  invLabel: string,
  orgName: string,
): string {
  if (kind === "INVOICE_ISSUED") {
    return `Invoice${invLabel} issued for ${orgName}`;
  }
  if (kind === "INVOICE_PAID") {
    return `Invoice${invLabel} paid for ${orgName}`;
  }
  return `Wallet top-up confirmed for ${orgName}`;
}

const BILLING_CTA_LABELS: Record<OrgBillingReceiptKind, string> = {
  INVOICE_ISSUED: "View & pay invoice",
  INVOICE_PAID: "View receipt",
  WALLET_TOPUP_CONFIRMED: "View wallet balance",
};

function OrgBillingBody(props: {
  kind: OrgBillingReceiptKind;
  invLabel: string;
  orgName: string;
  amountText: string;
  dueDateText?: string | null;
  newBalanceText?: string | null;
  settledText?: string | null;
}) {
  if (props.kind === "INVOICE_ISSUED") {
    return (
      <Text style={paragraph}>
        Invoice{props.invLabel ? <strong>{props.invLabel}</strong> : null} for{" "}
        <strong>{props.orgName}</strong> in the amount of{" "}
        <strong>{props.amountText}</strong> has been issued
        {props.dueDateText ? (
          <>
            {" "}
            and is due on <strong>{props.dueDateText}</strong>
          </>
        ) : null}
        .
      </Text>
    );
  }
  if (props.kind === "INVOICE_PAID") {
    return (
      <Text style={paragraph}>
        We received your payment of <strong>{props.amountText}</strong> for
        invoice{props.invLabel ? <strong>{props.invLabel}</strong> : null} on{" "}
        <strong>{props.orgName}</strong>.
      </Text>
    );
  }
  return (
    <Text style={paragraph}>
      Your wallet top-up of <strong>{props.amountText}</strong> for{" "}
      <strong>{props.orgName}</strong> has been credited
      {props.settledText ? (
        <>
          . <strong>{props.settledText}</strong> of it settled an amount your
          organisation owed us
        </>
      ) : null}
      {props.newBalanceText ? (
        <>
          . Updated balance: <strong>{props.newBalanceText}</strong>
        </>
      ) : null}
      .
    </Text>
  );
}

export const OrgBillingReceiptEmail = ({
  kind,
  recipientName,
  orgName,
  amountText,
  invoiceNumber,
  dueDateText,
  newBalanceText,
  settledText,
  dashboardUrl,
  unsubscribeUrl,
}: OrgBillingReceiptEmailProps) => {
  const invLabel = invoiceNumber ? ` ${invoiceNumber}` : "";
  const title = billingTitle(kind, invLabel, orgName);

  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl} showSupport>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <OrgBillingBody
        kind={kind}
        invLabel={invLabel}
        orgName={orgName}
        amountText={amountText}
        dueDateText={dueDateText}
        newBalanceText={newBalanceText}
        settledText={settledText}
      />
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {BILLING_CTA_LABELS[kind]}
        </Button>
      </Section>
    </EmailLayout>
  );
};

export default OrgBillingReceiptEmail;
