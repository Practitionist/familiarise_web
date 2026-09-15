import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface AccountSuspendedEmailProps {
  recipientName: string;
  reason?: string;
  /** Pre-formatted in the recipient's zone; absent when no end date was set. */
  suspendedUntilText?: string;
  appointmentsCancelled: number;
  supportEmail: string;
}

export const ACCOUNT_SUSPENDED_SUBJECT =
  "Your Familiarise account is suspended";

/** "2 upcoming appointments were cancelled." — shared with the ban notice. */
export function cancelledCountText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 upcoming appointment was cancelled as a result."
    : `${count} upcoming appointments were cancelled as a result.`;
}

// A required notice: no unsubscribe or preferences links, and the footer
// says so (#1653).
export default function AccountSuspendedEmail({
  recipientName,
  reason,
  suspendedUntilText,
  appointmentsCancelled,
  supportEmail,
}: AccountSuspendedEmailProps) {
  const cancelled = cancelledCountText(appointmentsCancelled);
  return (
    <EmailLayout preview={ACCOUNT_SUSPENDED_SUBJECT} requiredNotice>
      <Text style={heading}>{ACCOUNT_SUSPENDED_SUBJECT}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        {suspendedUntilText ? (
          <>
            Your account is suspended until{" "}
            <strong>{suspendedUntilText}</strong>. Until then you cannot sign
            in, book, or take part in sessions.
          </>
        ) : (
          "Your account is suspended. While it is suspended you cannot sign in, book, or take part in sessions."
        )}
      </Text>
      {reason && (
        <Text style={paragraph}>
          Reason given: <em>{reason}</em>
        </Text>
      )}
      {cancelled && <Text style={paragraph}>{cancelled}</Text>}
      <Text style={paragraph}>
        If you believe this was a mistake, write to {supportEmail} and a member
        of the team will review it.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={`mailto:${supportEmail}`}>
          Contact support
        </Button>
      </Section>
    </EmailLayout>
  );
}
