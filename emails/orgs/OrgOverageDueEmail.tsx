import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface OrgOverageDueEmailProps {
  recipientName: string;
  orgName: string;
  programTitle: string;
  /** Already formatted, e.g. "₹1,200.00". */
  amountText: string;
  /** Already rendered in the recipient's zone; omitted when no deadline is known. */
  dueByText?: string;
  payUrl: string;
  unsubscribeUrl?: string | null;
}

// #1653 — ORG_PROGRAM_OVERAGE_DUE; the member pays the marginal amount of an
// over-allowance booking, and the charge lapses if they do not.
export const OrgOverageDueEmail = ({
  recipientName,
  orgName,
  programTitle,
  amountText,
  dueByText,
  payUrl,
  unsubscribeUrl,
}: OrgOverageDueEmailProps) => (
  <EmailLayout
    preview="Payment due for your recent booking"
    unsubscribeUrl={unsubscribeUrl}
    showSupport
  >
    <Text style={heading}>Payment due for your recent booking</Text>
    <Text style={paragraph}>Hi {recipientName},</Text>
    <Text style={paragraph}>
      Your booking went over the <strong>{programTitle}</strong> allowance at{" "}
      <strong>{orgName}</strong>. <strong>{amountText}</strong> is due from you
      to keep it.
    </Text>
    <Text style={paragraph}>
      {dueByText
        ? `Please pay by ${dueByText}. `
        : "Please pay as soon as you can. "}
      If the charge is not paid in time, the payment window closes and the
      booking is not kept.
    </Text>
    <Section style={buttonContainer}>
      <Button style={button} href={payUrl}>
        Pay now
      </Button>
    </Section>
  </EmailLayout>
);

export default OrgOverageDueEmail;
