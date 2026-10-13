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

export function orgInvoiceOverdueSubject(args: {
  invoiceNumber: string;
  daysLate: number;
  reminderStage?: number;
}): string {
  if (args.reminderStage && args.reminderStage > 3) {
    return `Sponsored bookings paused: Invoice ${args.invoiceNumber} overdue`;
  }
  const dayWord = args.daysLate === 1 ? "day" : "days";
  return `Invoice ${args.invoiceNumber} is ${args.daysLate} ${dayWord} overdue`;
}

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
  const isSuspendedStage = Boolean(reminderStage && reminderStage > 3);
  const subject = orgInvoiceOverdueSubject({
    invoiceNumber,
    daysLate,
    reminderStage,
  });
  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl} showSupport>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>
        Invoice <strong>{invoiceNumber}</strong> for <strong>{orgName}</strong>,
        totalling <strong>{amountText}</strong>, was due on {dueDateText} and is
        still unpaid.
      </Text>
      {isSuspendedStage ? (
        <Text style={paragraph}>
          Sponsored bookings for <strong>{orgName}</strong> have been paused
          until this overdue invoice is settled.
        </Text>
      ) : reminderStage > 0 ? (
        <Text style={paragraph}>This is reminder {reminderStage}.</Text>
      ) : null}
      <Text style={paragraph}>
        {isSuspendedStage
          ? "Paying the overdue invoice automatically restores sponsored bookings for your organisation."
          : "While an invoice stays overdue, new sponsored bookings for the organisation can be blocked. Paying it lifts that restriction on its own."}
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
