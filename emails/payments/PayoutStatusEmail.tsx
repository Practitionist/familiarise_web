import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import { payoutMethodLabel } from "@/lib/labels/money-labels";
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

function payoutTitle(
  status: PayoutStatusKind,
  amountText: string,
  target: string,
): string {
  if (status === "COMPLETED") {
    return `Your payout of ${amountText}${target} is complete`;
  }
  if (status === "REVERSED") {
    return `Your payout${target} was reversed`;
  }
  return `Your payout${target} could not be completed`;
}

function PayoutSummaryParagraph(props: {
  status: PayoutStatusKind;
  amountText: string;
  orgName?: string | null;
  method?: string | null;
  payoutId: string;
}) {
  const orgNode = props.orgName ? (
    <>
      {" "}
      to <strong>{props.orgName}</strong>
    </>
  ) : null;

  if (props.status === "COMPLETED") {
    return (
      <Text style={paragraph}>
        We sent a payout of <strong>{props.amountText}</strong>
        {orgNode}
        {props.method ? ` (${payoutMethodLabel(props.method)})` : ""}. Payout
        reference: <strong>{props.payoutId}</strong>.
      </Text>
    );
  }
  const suffix =
    props.status === "REVERSED"
      ? "was returned by the receiving bank."
      : "could not be completed.";
  return (
    <Text style={paragraph}>
      A payout of <strong>{props.amountText}</strong>
      {orgNode} (reference: <strong>{props.payoutId}</strong>) {suffix}
    </Text>
  );
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
  const title = payoutTitle(status, amountText, target);

  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl} showSupport>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <PayoutSummaryParagraph
        status={status}
        amountText={amountText}
        orgName={orgName}
        method={method}
        payoutId={payoutId}
      />
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
          The funds remain in your payable balance and will be included in the
          next scheduled payout run.
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
