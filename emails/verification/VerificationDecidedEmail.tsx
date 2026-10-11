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
  | "UNDER_REVIEW"
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
    case "UNDER_REVIEW":
      return "Your Familiarise expert profile is under review";
    case "NEEDS_INFO_REMINDER":
      return "Reminder: your expert profile is waiting on you";
    case "PENDING_VERIFICATION":
    default:
      return "We need more information for your expert profile";
  }
}

function renderVerificationBody(
  status: VerificationDecidedStatus,
  daysLeft?: number,
): React.ReactNode {
  switch (status) {
    case "VERIFIED":
      return (
        <Text style={paragraph}>
          Your expert profile is verified and now visible to clients. You can
          start receiving bookings from your dashboard.
        </Text>
      );
    case "REJECTED":
      return (
        <Text style={paragraph}>
          Your expert profile verification was not approved. Read the feedback
          below, update your profile, and resubmit when ready.
        </Text>
      );
    case "UNDER_REVIEW":
      return (
        <Text style={paragraph}>
          We received your expert profile submission and our verification team
          is reviewing it. We will notify you as soon as a decision is recorded.
        </Text>
      );
    case "NEEDS_INFO_REMINDER": {
      const dayUnit = daysLeft === 1 ? "day" : "days";
      const deadlineClause =
        typeof daysLeft === "number"
          ? ` within ${daysLeft} ${dayUnit}`
          : " soon";
      return (
        <Text style={paragraph}>
          A reviewer asked for more information on your expert profile and has
          not heard back. Reply from your profile settings
          {deadlineClause}, or the request will close and you will need to
          submit again.
        </Text>
      );
    }
    case "PENDING_VERIFICATION":
    default:
      return (
        <Text style={paragraph}>
          A reviewer looked at your expert profile and needs a little more
          information before it can be approved. Read the note below and update
          your profile.
        </Text>
      );
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
      {renderVerificationBody(status, daysLeft)}
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
