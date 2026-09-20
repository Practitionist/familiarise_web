import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type VerificationDecidedStatus =
  | "VERIFIED"
  | "REJECTED"
  | "PENDING_VERIFICATION"
  /** Day-7 reminder from the sweep: the NEEDS_INFO above is still unanswered. */
  | "NEEDS_INFO_REMINDER";

export interface VerificationDecidedEmailProps {
  recipientName?: string;
  status: VerificationDecidedStatus;
  reason?: string;
  dashboardUrl: string;
  supportEmail: string;
  /** Days left before an unanswered request closes (reminder only). */
  daysLeft?: number;
}

export function verificationDecidedSubject(
  status: VerificationDecidedStatus,
): string {
  switch (status) {
    case "VERIFIED":
      return "Your Familiarise expert profile is verified";
    case "REJECTED":
      return "Your Familiarise expert profile was not approved";
    case "NEEDS_INFO_REMINDER":
      return "Reminder: your expert profile is waiting on you";
    case "PENDING_VERIFICATION":
    default:
      return "We need more information for your expert profile";
  }
}

// Required notice mirroring the verification-status-changed bell: the
// consultant must know the review outcome even with all mail muted.
export default function VerificationDecidedEmail({
  recipientName = "there",
  status,
  reason,
  dashboardUrl,
  supportEmail,
  daysLeft,
}: VerificationDecidedEmailProps) {
  const subject = verificationDecidedSubject(status);
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {status === "VERIFIED" ? (
        <Text style={paragraph}>
          Your expert profile is verified and now visible to clients. You can
          start receiving bookings from your dashboard.
        </Text>
      ) : status === "REJECTED" ? (
        <Text style={paragraph}>
          Your expert profile verification was not approved. Read the feedback
          below, update your profile, and resubmit when ready.
        </Text>
      ) : status === "NEEDS_INFO_REMINDER" ? (
        <Text style={paragraph}>
          A reviewer asked for more information on your expert profile and has
          not heard back. Reply from your profile settings
          {typeof daysLeft === "number"
            ? ` within ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`
            : " soon"}
          , or the request will close and you will need to submit again.
        </Text>
      ) : (
        <Text style={paragraph}>
          A reviewer looked at your expert profile and needs a little more
          information before it can be approved. Read the note below and update
          your profile.
        </Text>
      )}
      {reason && (
        <Text style={paragraph}>
          Reviewer note: <em>{reason}</em>
        </Text>
      )}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          Open profile settings
        </Button>
      </Section>
      <Text style={paragraph}>
        Questions? Write to {supportEmail} and a member of the team will help.
      </Text>
    </EmailLayout>
  );
}
