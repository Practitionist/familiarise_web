import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface SupportTicketUpdateEmailProps {
  recipientName: string;
  /** The ticket's human reference; absent on a legacy row. */
  reference?: string;
  title: string;
  /** The status as the clause after "is now": "in progress", "resolved". */
  statusLabel: string;
  /** What happens next for that status, one or two sentences. */
  nextStepText: string;
  ticketUrl: string;
  unsubscribeUrl?: string | null;
}

export function supportTicketUpdateSubject({
  reference,
  statusLabel,
}: Pick<SupportTicketUpdateEmailProps, "reference" | "statusLabel">): string {
  return reference
    ? `Your ticket ${reference} is now ${statusLabel}`
    : `Your ticket is now ${statusLabel}`;
}

export default function SupportTicketUpdateEmail({
  recipientName,
  reference,
  title,
  statusLabel,
  nextStepText,
  ticketUrl,
  unsubscribeUrl,
}: SupportTicketUpdateEmailProps) {
  const subject = supportTicketUpdateSubject({ reference, statusLabel });
  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        The status of your ticket{" "}
        {reference && (
          <>
            <strong>{reference}</strong>{" "}
          </>
        )}
        ({title}) changed to <strong>{statusLabel}</strong>.
      </Text>
      <Text style={paragraph}>{nextStepText}</Text>
      <Section style={buttonContainer}>
        <Button style={button} href={ticketUrl}>
          View ticket
        </Button>
      </Section>
    </EmailLayout>
  );
}
