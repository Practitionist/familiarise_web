import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export const CLAWBACK_NOTICE_SUBJECT = "Payout adjustment recorded";

export interface ClawbackNoticeEmailProps {
  recipientName: string;
  organization: boolean;
  amountText: string;
  payoutId: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

/** A refund or chargeback after a payout left the payee owing money back. */
export function ClawbackNoticeEmail(props: Readonly<ClawbackNoticeEmailProps>) {
  const whose = props.organization ? "your organisation's" : "your";
  return (
    <EmailLayout
      preview={CLAWBACK_NOTICE_SUBJECT}
      unsubscribeUrl={props.unsubscribeUrl}
      showSupport
    >
      <Text style={heading}>{CLAWBACK_NOTICE_SUBJECT}</Text>
      <Text style={paragraph}>Hi {props.recipientName},</Text>
      <Text style={paragraph}>
        A booking whose earnings were already paid out was refunded or lost to a
        chargeback, so <strong>{props.amountText}</strong> is now owed back. It
        will be deducted from {whose} next eligible payouts. Nothing is taken
        from a bank account.
      </Text>
      <Text style={paragraph}>
        Payout reference: <strong>{props.payoutId}</strong>.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={props.dashboardUrl}>
          View payouts
        </Button>
      </Section>
    </EmailLayout>
  );
}
