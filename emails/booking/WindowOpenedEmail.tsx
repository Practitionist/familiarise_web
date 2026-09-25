import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface WindowOpenedEmailProps {
  recipientName: string;
  consultantName: string;
  windowText: string;
  bookUrl: string;
  unsubscribeUrl?: string | null;
}

/** #1778 — a held time the learner asked about has freed; first to book wins. */
export default function WindowOpenedEmail({
  recipientName,
  consultantName,
  windowText,
  bookUrl,
  unsubscribeUrl,
}: WindowOpenedEmailProps) {
  const title = `A time with ${consultantName} just opened`;
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        The time you asked about, <strong>{windowText}</strong>, is free again.
        It is not held for you: the first person to book it gets it.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={bookUrl}>
          Book this time
        </Button>
      </Section>
    </EmailLayout>
  );
}
