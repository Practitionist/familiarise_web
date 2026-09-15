import * as React from "react";
import { Button, Link, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  link,
  paragraph,
} from "@/emails/components/styles";

export interface RefundProcessedEmailProps {
  recipientName: string;
  /** Already formatted, e.g. "₹1,200.00". */
  amountText: string;
  planTitle?: string;
  /** The Sec 34 credit note the refund cascade minted, when one is in scope. */
  creditNoteNumber?: string;
  refundPolicyUrl: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

// #1653 — REFUND_PROCESSED. The 5–7 working days line matches the in-app copy.
export const RefundProcessedEmail = ({
  recipientName,
  amountText,
  planTitle,
  creditNoteNumber,
  refundPolicyUrl,
  dashboardUrl,
  unsubscribeUrl,
}: RefundProcessedEmailProps) => (
  <EmailLayout
    preview={`Your refund of ${amountText} is on its way`}
    unsubscribeUrl={unsubscribeUrl}
    showSupport
  >
    <Text style={heading}>Your refund is on its way</Text>
    <Text style={paragraph}>Hi {recipientName},</Text>
    <Text style={paragraph}>
      We have refunded <strong>{amountText}</strong>
      {planTitle ? (
        <>
          {" "}
          for <strong>{planTitle}</strong>
        </>
      ) : null}
      . Banks typically post refunds within 5–7 working days, so it may take a
      little while to show on your statement.
    </Text>
    {creditNoteNumber ? (
      <Text style={paragraph}>
        Credit note reference: <strong>{creditNoteNumber}</strong>. Keep this
        for your records.
      </Text>
    ) : null}
    <Section style={buttonContainer}>
      <Button style={button} href={dashboardUrl}>
        View receipt
      </Button>
    </Section>
    <Text style={paragraph}>
      You can read how refunds work in our{" "}
      <Link href={refundPolicyUrl} style={link}>
        refund policy
      </Link>
      .
    </Text>
  </EmailLayout>
);

export default RefundProcessedEmail;
