import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import { cancelledCountText } from "@/emails/account/AccountSuspendedEmail";

export type AccountRestrictedEmailKind =
  | "BANNED"
  | "SUSPENDED"
  | "REINSTATED"
  | "MODERATION_WARNING"
  | "WARNING"
  | "CONTENT_REMOVED"
  | "REVIEW_EXCLUDED";

export interface AccountRestrictedEmailProps {
  kind: AccountRestrictedEmailKind;
  recipientName?: string;
  reason?: string | null;
  suspendedUntilText?: string | null;
  appointmentsCancelled?: number;
  supportEmail: string;
  supportUrl?: string;
  dashboardUrl?: string;
}

export function accountRestrictedSubject(
  kind: AccountRestrictedEmailKind,
): string {
  switch (kind) {
    case "BANNED":
      return "Your Familiarise account has been permanently closed";
    case "SUSPENDED":
      return "Your Familiarise account is suspended";
    case "REINSTATED":
      return "Your Familiarise account access has been restored";
    case "MODERATION_WARNING":
    case "WARNING":
      return "Moderation warning on your Familiarise account";
    case "CONTENT_REMOVED":
      return "Your content was removed on Familiarise";
    case "REVIEW_EXCLUDED":
      return "A review on your profile no longer counts toward your rating";
  }
}

export function AccountRestrictedEmail({
  kind,
  recipientName = "there",
  reason,
  suspendedUntilText,
  appointmentsCancelled = 0,
  supportEmail,
  supportUrl,
  dashboardUrl,
}: Readonly<AccountRestrictedEmailProps>) {
  const subject = accountRestrictedSubject(kind);
  const cancelled = cancelledCountText(appointmentsCancelled);
  const ctaHref =
    kind === "REINSTATED" || kind === "REVIEW_EXCLUDED"
      ? (dashboardUrl ?? supportUrl ?? `mailto:${supportEmail}`)
      : (supportUrl ?? `mailto:${supportEmail}`);
  const ctaLabel =
    kind === "REINSTATED" || kind === "REVIEW_EXCLUDED"
      ? "Open dashboard"
      : "Contact support";

  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {kind === "BANNED" ? (
        <Text style={paragraph}>
          Your account has been permanently closed. You can no longer sign in,
          book, or take part in sessions.
        </Text>
      ) : null}

      {kind === "SUSPENDED" ? (
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
      ) : null}

      {kind === "REINSTATED" ? (
        <Text style={paragraph}>
          Your Familiarise account restriction has been lifted and full access
          is restored. You can sign in and manage your sessions again.
        </Text>
      ) : null}

      {kind === "MODERATION_WARNING" || kind === "WARNING" ? (
        <Text style={paragraph}>
          You have received a moderation warning regarding your account activity
          under our community guidelines. Repeated violations may result in
          account suspension.
        </Text>
      ) : null}

      {kind === "CONTENT_REMOVED" ? (
        <Text style={paragraph}>
          Your content was removed because it did not align with our community
          guidelines.
        </Text>
      ) : null}

      {kind === "REVIEW_EXCLUDED" ? (
        <Text style={paragraph}>
          A client review on your profile has been marked as not counted in your
          rating following moderation review. It remains visible for
          transparency without affecting your average score.
        </Text>
      ) : null}

      {reason ? (
        <Text style={paragraph}>
          Note: <em>{reason}</em>
        </Text>
      ) : null}

      {cancelled ? <Text style={paragraph}>{cancelled}</Text> : null}

      <Section style={buttonContainer}>
        <Button style={button} href={ctaHref}>
          {ctaLabel}
        </Button>
      </Section>

      <Text style={paragraph}>
        Questions? Write to {supportEmail} and a member of our team will help.
      </Text>
    </EmailLayout>
  );
}

export default AccountRestrictedEmail;
