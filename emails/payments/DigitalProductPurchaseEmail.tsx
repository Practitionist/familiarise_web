import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface DigitalProductPurchaseEmailProps {
  recipientName: string;
  productTitle: string;
  creatorName?: string | null;
  /** Already formatted, e.g. "₹499.00"; null for a free claim. */
  amountText: string | null;
  /** The buyer's library, never a file URL: downloads need a signed-in session. */
  libraryUrl: string;
  unsubscribeUrl?: string | null;
}

export function digitalProductPurchaseSubject(
  productTitle: string,
  free: boolean,
): string {
  return free
    ? `${productTitle} is in your library`
    : `Your purchase: ${productTitle}`;
}

export const DigitalProductPurchaseEmail = ({
  recipientName,
  productTitle,
  creatorName,
  amountText,
  libraryUrl,
  unsubscribeUrl,
}: DigitalProductPurchaseEmailProps) => (
  <EmailLayout
    preview={`${productTitle} is ready to download`}
    unsubscribeUrl={unsubscribeUrl}
    showSupport
  >
    <Text style={heading}>Your files are ready</Text>
    <Text style={paragraph}>Hi {recipientName},</Text>
    <Text style={paragraph}>
      <strong>{productTitle}</strong>
      {creatorName ? <> by {creatorName}</> : null} is now in your library.
      {amountText ? (
        <>
          {" "}
          We received your payment of <strong>{amountText}</strong>.
        </>
      ) : null}
    </Text>
    <Text style={paragraph}>
      Download the files any time from your library. When the creator updates a
      file you get the new version there.
    </Text>
    <Section style={buttonContainer}>
      <Button style={button} href={libraryUrl}>
        Open your library
      </Button>
    </Section>
    {amountText ? (
      <Text style={paragraph}>
        You can ask for a refund until you first download a file.
      </Text>
    ) : null}
  </EmailLayout>
);

export default DigitalProductPurchaseEmail;
