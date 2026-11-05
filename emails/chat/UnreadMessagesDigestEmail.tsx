import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface UnreadDigestThreadLine {
  /** Counterpart, count and session date only; never message text. */
  line: string;
  href: string;
}

export interface UnreadMessagesDigestEmailProps {
  recipientName: string;
  threads: UnreadDigestThreadLine[];
  unsubscribeUrl?: string | null;
}

export function unreadMessagesDigestSubject(threadCount: number): string {
  return threadCount === 1
    ? "You have unread messages"
    : `You have unread messages in ${threadCount} conversations`;
}

/** The chat unread digest. It names who wrote and when the session is, never what was written. */
export default function UnreadMessagesDigestEmail({
  recipientName,
  threads,
  unsubscribeUrl,
}: UnreadMessagesDigestEmailProps) {
  const title = unreadMessagesDigestSubject(threads.length);
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {threads.map((thread) => (
        <Section key={thread.href}>
          <Text style={paragraph}>{thread.line}</Text>
          <Section style={buttonContainer}>
            <Button style={button} href={thread.href}>
              Open conversation
            </Button>
          </Section>
        </Section>
      ))}
      <Text style={paragraph}>
        For your privacy we never include message text in email. Sign in to read
        and reply.
      </Text>
    </EmailLayout>
  );
}
