import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface RefundFailedEmailProps {
  recipientName: string;
  /** Already formatted, e.g. "₹1,200.00". */
  amountText: string;
  /** The support mailbox; the CTA is a mailto: to it (#1649). */
  supportEmail: string;
  unsubscribeUrl?: string | null;
}

// #1653 — REFUND_FAILED. The team retries; the CTA is the only inbox that
// can receive mail on the domain (#1649).
export const RefundFailedEmail = ({
  recipientName,
  amountText,
  supportEmail,
  unsubscribeUrl,
}: RefundFailedEmailProps) => (
  <EmailLayout
    preview="We couldn't complete your refund"
    unsubscribeUrl={unsubscribeUrl}
    showSupport
  >
    <Text style={heading}>We couldn&apos;t complete your refund</Text>
    <Text style={paragraph}>Hi {recipientName},</Text>
    <Text style={paragraph}>
      The refund of <strong>{amountText}</strong> could not be completed by the
      payment provider. Our team will retry it, and you do not need to do
      anything right now.
    </Text>
    <Text style={paragraph}>
      If the money has not arrived in a few days, write to us and we will sort
      it out.
    </Text>
    <Section style={buttonContainer}>
      <Button style={button} href={`mailto:${supportEmail}`}>
        Contact support
      </Button>
    </Section>
  </EmailLayout>
);

export default RefundFailedEmail;
