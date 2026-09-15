import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface OrgWalletLowEmailProps {
  orgName: string;
  /** Already formatted, e.g. "₹1,200.00". */
  balanceText: string;
  /** The configured minimum, already formatted. */
  floorText: string;
  topUpUrl: string;
  unsubscribeUrl?: string | null;
}

// #1653 — ORG_WALLET_LOW; the wallet job is notify-only, so the copy only
// says what an empty wallet blocks.
export const OrgWalletLowEmail = ({
  orgName,
  balanceText,
  floorText,
  topUpUrl,
  unsubscribeUrl,
}: OrgWalletLowEmailProps) => (
  <EmailLayout
    preview={`${orgName}'s wallet is running low`}
    unsubscribeUrl={unsubscribeUrl}
    showSupport
  >
    <Text style={heading}>{orgName}&apos;s wallet is running low</Text>
    <Text style={paragraph}>
      The wallet for <strong>{orgName}</strong> is down to{" "}
      <strong>{balanceText}</strong>, below the <strong>{floorText}</strong>{" "}
      minimum you set.
    </Text>
    <Text style={paragraph}>
      When the balance reaches zero, wallet-funded bookings are blocked until it
      is topped up.
    </Text>
    <Section style={buttonContainer}>
      <Button style={button} href={topUpUrl}>
        Top up wallet
      </Button>
    </Section>
  </EmailLayout>
);

export default OrgWalletLowEmail;
