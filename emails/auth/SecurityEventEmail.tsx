import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type SecurityEvent =
  | { kind: "authenticator-added" }
  | { kind: "passkey-added"; passkeyName: string | null }
  | { kind: "backup-codes-regenerated" }
  | { kind: "backup-code-used"; remaining: number }
  | { kind: "two-factor-reset-by-admin" }
  | { kind: "two-factor-locked"; lockedUntil: Date };

export interface SecurityEventEmailProps {
  recipientName: string;
  event: SecurityEvent;
  /** Pre-formatted in the recipient's zone. */
  occurredAtText: string;
  /** Pre-formatted in the recipient's zone; read only for `two-factor-locked`. */
  lockedUntilText?: string;
  supportEmail: string;
}

export const LOW_BACKUP_CODES = 3;

export function securityEventSubject(event: SecurityEvent): string {
  switch (event.kind) {
    case "authenticator-added":
      return "An authenticator app was added to your Familiarise account";
    case "passkey-added":
      return "A passkey was added to your Familiarise account";
    case "backup-codes-regenerated":
      return "Your Familiarise backup codes were regenerated";
    case "backup-code-used":
      return "A backup code was used on your Familiarise account";
    case "two-factor-reset-by-admin":
      return "Your Familiarise two-factor authentication was reset";
    case "two-factor-locked":
      return "Two-factor sign-in is locked on your Familiarise account";
  }
}

function codesLeft(count: number): string {
  return count === 1 ? "1 backup code" : `${count} backup codes`;
}

function eventLines(
  event: SecurityEvent,
  when: string,
  lockedUntilText: string | undefined,
): string[] {
  switch (event.kind) {
    case "authenticator-added":
      return [
        `An authenticator app was set up for two-factor sign-in on your account on ${when}.`,
      ];
    case "passkey-added":
      return [
        event.passkeyName
          ? `A new passkey, "${event.passkeyName}", was added to your account on ${when}. It can now be used to sign in.`
          : `A new passkey was added to your account on ${when}. It can now be used to sign in.`,
      ];
    case "backup-codes-regenerated":
      return [
        `New two-factor backup codes were generated for your account on ${when}. Your previous backup codes no longer work.`,
      ];
    case "backup-code-used": {
      const lines = [
        `One of your two-factor backup codes was used on ${when}. You have ${codesLeft(event.remaining)} left.`,
      ];
      if (event.remaining <= LOW_BACKUP_CODES) {
        lines.push(
          "Generate a new set of backup codes from your security settings now so you are not locked out.",
        );
      }
      return lines;
    }
    case "two-factor-reset-by-admin":
      return [
        `An administrator reset two-factor authentication on your account on ${when}.`,
        "Use the setup link in the separate email we sent you to set a new password, then set up two-factor authentication again.",
      ];
    case "two-factor-locked":
      return [
        `Too many incorrect two-factor codes were entered for your account, most recently on ${when}.`,
        `Two-factor sign-in is locked until ${lockedUntilText ?? "the lock expires"}. Someone who tried may already know your password, so change it once you are back in.`,
      ];
  }
}

// A required notice: no unsubscribe or preferences links.
export default function SecurityEventEmail({
  recipientName,
  event,
  occurredAtText,
  lockedUntilText,
  supportEmail,
}: SecurityEventEmailProps) {
  const subject = securityEventSubject(event);
  return (
    <EmailLayout preview={subject} requiredNotice>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {eventLines(event, occurredAtText, lockedUntilText).map((line) => (
        <Text key={line} style={paragraph}>
          {line}
        </Text>
      ))}
      <Text style={paragraph}>
        <strong>If this wasn&apos;t you</strong>, contact support at{" "}
        {supportEmail} or your administrator immediately.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={`mailto:${supportEmail}`}>
          Contact support
        </Button>
      </Section>
    </EmailLayout>
  );
}
