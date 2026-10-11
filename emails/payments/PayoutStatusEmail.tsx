import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type PayoutStatusKind = "COMPLETED" | "FAILED" | "REVERSED";

export interface PayoutStatusEmailProps {
  status: PayoutStatusKind;
  recipientName: string;
  orgName?: string | null;
  amountText: string;
  payoutId: string;
  method?: string | null;
  reason?: string | null;
  withheldText?: string | null;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export const PayoutStatusEmail = ({
  status,
  recipientName,
  orgName,
  amountText,
  payoutId,
  method,
  reason,
  withheldText,
  dashboardUrl,
  unsubscribeUrl,
}: PayoutStatusEmailProps) => {
  const target = orgName ? ` to ${orgName}` : "";
  const title =
    status === "COMPLETED"
      ? `Your payout of ${amountText}${target} is complete`
      : status === "REVERSED"
        ? `Your payout${target} was reversed`
        : `Your payout${target} could not be completed`;

  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl} showSupport>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {status === "COMPLETED" ? (
        <Text style={paragraph}>
          We sent a payout of <strong>{amountText}</strong>
          {orgName ? (
            <>
              {" "}
              to <strong>{orgName}</strong>
            </>
          ) : null}
          {method ? ` (${method})` : ""}. Payout reference:{" "}
          <strong>{payoutId}</strong>.
        </Text>
      ) : status === "REVERSED" ? (
        <Text style={paragraph}>
          A payout of <strong>{amountText}</strong>
          {orgName ? (
            <>
              {" "}
              to <strong>{orgName}</strong>
            </>
          ) : null}{" "}
          (reference: <strong>{payoutId}</strong>) was returned by the receiving
          bank.
        </Text>
      ) : (
        <Text style={paragraph}>
          A payout of <strong>{amountText}</strong>
          {orgName ? (
            <>
              {" "}
              to <strong>{orgName}</strong>
            </>
          ) : null}{" "}
          (reference: <strong>{payoutId}</strong>) could not be completed.
        </Text>
      )}
      {reason ? (
        <Text style={paragraph}>
          Reason: <strong>{reason}</strong>
        </Text>
      ) : null}
      {withheldText ? (
        <Text style={paragraph}>
          Includes <strong>{withheldText}</strong> withheld as TDS.
        </Text>
      ) : null}
      {status !== "COMPLETED" ? (
        <Text style={paragraph}>
          The funds remain in your payable balance and will retry on the next
          payout run after your payout account details are verified.
        </Text>
      ) : null}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          View payouts
        </Button>
      </Section>
    </EmailLayout>
  );
};

export default PayoutStatusEmail;
