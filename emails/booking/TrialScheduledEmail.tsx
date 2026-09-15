import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export interface TrialScheduledEmailProps {
  role: "consultee" | "consultant";
  recipientName: string;
  otherPartyName: string;
  planTitle: string;
  /** Pre-formatted in the recipient's zone. */
  startsAtText: string;
  /** True while a paid trial waits for its payment; the time is held, not confirmed. */
  awaitingPayment: boolean;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

export default function TrialScheduledEmail({
  role,
  recipientName,
  otherPartyName,
  planTitle,
  startsAtText,
  awaitingPayment,
  dashboardUrl,
  unsubscribeUrl,
}: TrialScheduledEmailProps) {
  const state = awaitingPayment ? "held until payment completes" : "confirmed";
  const title =
    role === "consultee"
      ? `Your free trial with ${otherPartyName} is ${state}`
      : `Trial with ${otherPartyName} is ${state}`;
  return (
    <EmailLayout
      preview={`${planTitle} — ${startsAtText}`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      <Text style={paragraph}>
        The trial session for <strong>{planTitle}</strong>{" "}
        {role === "consultee" ? "with" : "requested by"} {otherPartyName} is set
        for <strong>{startsAtText}</strong>
        {awaitingPayment
          ? ". The time is held until the trial payment completes."
          : "."}
      </Text>
      <Text style={paragraph}>
        A trial is one session to see whether the programme fits
        {role === "consultee"
          ? "; if it does, the full subscription picks up where the trial leaves off."
          : "."}
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {awaitingPayment && role === "consultee"
            ? "Complete payment"
            : "View trial"}
        </Button>
      </Section>
    </EmailLayout>
  );
}
