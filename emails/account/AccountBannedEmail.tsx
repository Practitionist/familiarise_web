import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import { cancelledCountText } from "./AccountSuspendedEmail";

export interface AccountBannedEmailProps {
  recipientName: string;
  reason?: string;
  appointmentsCancelled: number;
  supportEmail: string;
}

export const ACCOUNT_BANNED_SUBJECT =
  "Your Familiarise account has been permanently closed";

// The suspension notice without an end date; a required notice (#1653).
export default function AccountBannedEmail({
  recipientName,
  reason,
  appointmentsCancelled,
  supportEmail,
}: AccountBannedEmailProps) {
  const cancelled = cancelledCountText(appointmentsCancelled);
  return (
    <EmailLayout preview={ACCOUNT_BANNED_SUBJECT} requiredNotice>
      <Text style={heading}>{ACCOUNT_BANNED_SUBJECT}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        Your account has been permanently closed. You can no longer sign in,
        book, or take part in sessions.
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
