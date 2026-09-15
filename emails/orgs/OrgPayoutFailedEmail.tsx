import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface OrgPayoutFailedEmailProps {
  /** FAILED never left the platform; REVERSED was paid and came back. */
  kind: "FAILED" | "REVERSED";
  orgName: string;
  /** Already formatted, e.g. "₹1,200.00". */
  amountText: string;
  reason: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

// #1653 — ORG_PAYOUT_FAILED; one template for both kinds, as the bell does.
export const OrgPayoutFailedEmail = ({
  kind,
  orgName,
  amountText,
  reason,
  dashboardUrl,
  unsubscribeUrl,
}: OrgPayoutFailedEmailProps) => {
  const reversed = kind === "REVERSED";
  const title = reversed
    ? `A payout to ${orgName} was reversed`
    : `A payout to ${orgName} failed`;
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl} showSupport>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>
        {reversed ? (
          <>
            A payout of <strong>{amountText}</strong> to{" "}
            <strong>{orgName}</strong> was sent and then returned by the bank.
          </>
        ) : (
          <>
            A payout of <strong>{amountText}</strong> to{" "}
            <strong>{orgName}</strong> could not be sent.
          </>
        )}
      </Text>
      <Text style={paragraph}>
        Reason given: <strong>{reason}</strong>
      </Text>
      <Text style={paragraph}>
        The earnings behind it are back in the payable balance and will go out
        with the next payout run. If the reason points at the bank details,
        please check them on the payouts page first, otherwise nothing is needed
        from you.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          View details
        </Button>
      </Section>
    </EmailLayout>
  );
};

export default OrgPayoutFailedEmail;
