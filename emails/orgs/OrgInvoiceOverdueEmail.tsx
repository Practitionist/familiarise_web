import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface OrgInvoiceOverdueEmailProps {
  orgName: string;
  invoiceNumber: string;
  /** Already formatted, e.g. "₹1,200.00". */
  amountText: string;
  /** Already rendered in the recipient's zone. */
  dueDateText: string;
  daysLate: number;
  /** 0 for the first notice, then 1..3 for the escalation reminders. */
  reminderStage: number;
  payUrl: string;
  unsubscribeUrl?: string | null;
}

// #1653 — ORG_INVOICE_OVERDUE; the reminder number and the booking
// consequence mirror the dunning job's stages.
export const OrgInvoiceOverdueEmail = ({
  orgName,
  invoiceNumber,
  amountText,
  dueDateText,
  daysLate,
  reminderStage,
  payUrl,
  unsubscribeUrl,
}: OrgInvoiceOverdueEmailProps) => {
  const dayWord = daysLate === 1 ? "day" : "days";
  return (
    <EmailLayout
      preview={`Invoice ${invoiceNumber} is ${daysLate} ${dayWord} overdue`}
      unsubscribeUrl={unsubscribeUrl}
      showSupport
    >
      <Text style={heading}>
        Invoice {invoiceNumber} is {daysLate} {dayWord} overdue
      </Text>
      <Text style={paragraph}>
        Invoice <strong>{invoiceNumber}</strong> for <strong>{orgName}</strong>,
        totalling <strong>{amountText}</strong>, was due on {dueDateText} and is
        still unpaid.
      </Text>
      {reminderStage > 0 ? (
        <Text style={paragraph}>This is reminder {reminderStage}.</Text>
      ) : null}
      <Text style={paragraph}>
        While an invoice stays overdue, new sponsored bookings for the
        organisation can be blocked. Paying it lifts that restriction on its
        own.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={payUrl}>
          Pay now
        </Button>
      </Section>
      <Text style={paragraph}>
        The tax invoice is available from the billing page; GST applies at the
        rate shown on it.
      </Text>
    </EmailLayout>
  );
};

export default OrgInvoiceOverdueEmail;
