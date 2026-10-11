import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type DisputeNoticeKind = "OPENED" | "RESOLVED";

export interface DisputeNoticeEmailProps {
  kind: DisputeNoticeKind;
  recipientName: string;
  amountText: string;
  disputeId: string;
  paymentId?: string | null;
  reason?: string | null;
  outcome?: "WON" | "LOST" | string | null;
  respondByText?: string | null;
  dashboardUrl: string;
}

export const DisputeNoticeEmail = ({
  kind,
  recipientName,
  amountText,
  disputeId,
  paymentId,
  reason,
  outcome,
  respondByText,
  dashboardUrl,
}: DisputeNoticeEmailProps) => {
  const title =
    kind === "OPENED"
      ? `Payment dispute opened (${amountText})`
      : `Payment dispute resolved (${amountText})`;

  return (
    <EmailLayout preview={title} requiredNotice showSupport>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {kind === "OPENED" ? (
        <Text style={paragraph}>
          A dispute of <strong>{amountText}</strong> (reference:{" "}
          <strong>{disputeId}</strong>
          {paymentId ? `, payment ${paymentId}` : ""}) has been opened with the
          payment provider.
        </Text>
      ) : (
        <Text style={paragraph}>
          Dispute <strong>{disputeId}</strong> ({amountText}) has been resolved
          {outcome ? (
            <>
              {" "}
              with outcome: <strong>{outcome}</strong>
            </>
          ) : null}
          .
        </Text>
      )}
      {reason ? (
        <Text style={paragraph}>
          Reason: <strong>{reason}</strong>
        </Text>
      ) : null}
      {kind === "OPENED" && respondByText ? (
        <Text style={paragraph}>
          Evidence due by: <strong>{respondByText}</strong>.
        </Text>
      ) : null}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          Review dispute details
        </Button>
      </Section>
    </EmailLayout>
  );
};

export default DisputeNoticeEmail;
