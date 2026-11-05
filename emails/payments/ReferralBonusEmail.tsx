import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type ReferralBonusEmailKind =
  "BONUS_EARNED" | "WELCOME_BONUS" | "CREDITS_APPLIED";

export interface ReferralBonusEmailProps {
  kind: ReferralBonusEmailKind;
  recipientName?: string;
  counterpartyName?: string;
  amountText: string;
  remainingText?: string;
  appointmentType?: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export function referralBonusSubject(
  args: Pick<ReferralBonusEmailProps, "kind" | "amountText">,
): string {
  switch (args.kind) {
    case "BONUS_EARNED":
      return `You earned ${args.amountText} in referral credits`;
    case "WELCOME_BONUS":
      return `Welcome discount: ${args.amountText} on an eligible first booking`;
    case "CREDITS_APPLIED":
      return `${args.amountText} referral credit applied to your booking`;
  }
}

export function ReferralBonusEmail({
  kind,
  recipientName = "there",
  counterpartyName,
  amountText,
  remainingText,
  appointmentType = "booking",
  dashboardUrl,
  unsubscribeUrl,
}: Readonly<ReferralBonusEmailProps>) {
  const subject = referralBonusSubject({ kind, amountText });

  return (
    <EmailLayout preview={subject} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {kind === "BONUS_EARNED" ? (
        <Text style={paragraph}>
          <strong>{counterpartyName ?? "Your invitee"}</strong> qualified
          through your referral link, and <strong>{amountText}</strong> in
          credits has been added to your balance.
        </Text>
      ) : null}

      {kind === "WELCOME_BONUS" ? (
        <Text style={paragraph}>
          Welcome to Familiarise! Through{" "}
          <strong>{counterpartyName ?? "your referrer"}</strong>, you may
          qualify for a discount of <strong>{amountText}</strong> on an eligible
          first marketplace booking. The exact discount and eligibility are
          shown at checkout.
        </Text>
      ) : null}

      {kind === "CREDITS_APPLIED" ? (
        <Text style={paragraph}>
          <strong>{amountText}</strong> in referral credits was applied to your{" "}
          {appointmentType}
          {remainingText ? (
            <>
              . Remaining referral balance: <strong>{remainingText}</strong>
            </>
          ) : null}
          .
        </Text>
      ) : null}

      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          Open dashboard
        </Button>
      </Section>
    </EmailLayout>
  );
}

export default ReferralBonusEmail;
