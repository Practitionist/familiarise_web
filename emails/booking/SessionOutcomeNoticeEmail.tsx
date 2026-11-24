import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface SessionOutcomeNoticeEmailProps {
  recipientName: string;
  subject: string;
  /** From `lib/booking/outcome-notice-copy.ts`, the same words the bell shows. */
  lines: readonly string[];
  actionLabel: string;
  actionHref: string;
  unsubscribeUrl?: string | null;
}

export default function SessionOutcomeNoticeEmail({
  recipientName,
  subject,
  lines,
  actionLabel,
  actionHref,
  unsubscribeUrl,
}: Readonly<SessionOutcomeNoticeEmailProps>) {
  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {lines.map((line) => (
        <Text key={line} style={paragraph}>
          {line}
        </Text>
      ))}
      <Section style={buttonContainer}>
        <Button style={button} href={actionHref}>
          {actionLabel}
        </Button>
      </Section>
    </EmailLayout>
  );
}
