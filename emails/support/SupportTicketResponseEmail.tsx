import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface SupportTicketResponseEmailProps {
  recipientName: string;
  /** The ticket's human reference, e.g. "ST-2026-0142"; absent on a legacy row. */
  reference?: string;
  title: string;
  respondedBy: string;
  /** The reply as typed; line breaks are preserved. */
  replyText: string;
  ticketUrl: string;
  unsubscribeUrl?: string | null;
}

// The in-app bell truncates the reply at 140 characters; the preview line
// mirrors it so the inbox and the bell tell the same story.
const PREVIEW_LENGTH = 140;

export function supportTicketResponseSubject({
  respondedBy,
  reference,
}: Pick<SupportTicketResponseEmailProps, "respondedBy" | "reference">): string {
  return reference
    ? `${respondedBy} replied to your ticket ${reference}`
    : `${respondedBy} replied to your ticket`;
}

export default function SupportTicketResponseEmail({
  recipientName,
  reference,
  title,
  respondedBy,
  replyText,
  ticketUrl,
  unsubscribeUrl,
}: SupportTicketResponseEmailProps) {
  const subject = supportTicketResponseSubject({ respondedBy, reference });
  const preview =
    replyText.length > PREVIEW_LENGTH
      ? `${replyText.slice(0, PREVIEW_LENGTH)}…`
      : replyText;
  const lines = replyText.split(/\r?\n/);
  return (
    <EmailLayout preview={preview} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        {respondedBy} replied on your ticket{" "}
        {reference && (
          <>
            <strong>{reference}</strong>{" "}
          </>
        )}
        ({title}):
      </Text>
      <Section style={quote}>
        <Text style={quoteText}>
          {lines.map((line, index) => (
            <React.Fragment key={index}>
              {index > 0 && <br />}
              {line}
            </React.Fragment>
          ))}
        </Text>
      </Section>
      <Text style={paragraph}>
        To reply, open the ticket and write in the conversation. The support
        team sees your message as soon as it is sent.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={ticketUrl}>
          View ticket
        </Button>
      </Section>
    </EmailLayout>
  );
}

const quote = {
  borderLeft: "3px solid #e0e0e0",
  padding: "0 0 0 16px",
  margin: "0 0 20px",
};

const quoteText = {
  ...paragraph,
  margin: "0",
};
